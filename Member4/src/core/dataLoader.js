/**
 * Real Data Ingestion Pipeline.
 * Ingests precomputed NASA LOLA DEM binary heightmaps and JPL Horizons ephemerides.
 * Auto-detects real offline files; falls back to synthetic if files are not yet generated.
 */

export class DataLoader {
  constructor(basePath = './data') {
    this.basePath = basePath;
    // Fallback when data_out/sites.json is not served: ids only, no names or coordinates,
    // so nothing invented is shown next to a real site. Real values come from loadSites().
    this.availableSites = ['site04', 'site01', 'site07', 'site11', 'site23'].map((id) => ({
      id,
      name: `${id} (synthetic demo terrain)`,
    }));
  }

  /**
   * Attempts to load master site registry
   */
  async loadSites() {
    const tryLoad = async (base) => {
      const resp = await fetch(`${base}/sites.json`);
      if (resp.ok) {
        this.availableSites = await resp.json();
        return { isReal: true, sites: this.availableSites };
      }
      return null;
    };

    try {
      const res = await tryLoad(this.basePath);
      if (res) return res;
      if (this.basePath.startsWith('.')) {
        const res2 = await tryLoad('/data');
        if (res2) return res2;
      }
    } catch {
      try {
        const res2 = await tryLoad('/data');
        if (res2) return res2;
      } catch {}
    }
    return { isReal: false, sites: this.availableSites };
  }

  /**
   * Ingests all pipeline assets for a given site:
   * - angles/<site>.json
   * - mask/<site>.json
   * - results/<site>.json
   * - heightmap/<site>.json + near.bin + far.bin
   */
  async loadSiteData(siteId = 'site04') {
    const tryLoad = async (base) => {
      const [anglesResp, maskResp, resultsResp, hmMetaResp] = await Promise.all([
        fetch(`${base}/angles/${siteId}.json`),
        fetch(`${base}/mask/${siteId}.json`),
        fetch(`${base}/results/${siteId}.json`),
        fetch(`${base}/heightmap/${siteId}.json`),
      ]);

      if (anglesResp.ok && maskResp.ok && resultsResp.ok && hmMetaResp.ok) {
        const angles = await anglesResp.json();
        const mask = await maskResp.json();
        const results = await resultsResp.json();
        const hmMeta = await hmMetaResp.json();

        // Fetch binary heightmaps
        const nearBinUrl = `${base}/heightmap/${hmMeta.near.file}`;
        const farBinUrl = `${base}/heightmap/${hmMeta.far.file}`;

        const [nearBinResp, farBinResp] = await Promise.all([
          fetch(nearBinUrl),
          fetch(farBinUrl),
        ]);

        if (nearBinResp.ok && farBinResp.ok) {
          const nearBuf = await nearBinResp.arrayBuffer();
          const farBuf = await farBinResp.arrayBuffer();

          return {
            isReal: true,
            siteId,
            angles,
            mask,
            results,
            heightmap: {
              meta: hmMeta,
              nearBuffer: nearBuf,
              farBuffer: farBuf,
            },
          };
        }
      }
      return null;
    };

    try {
      const res = await tryLoad(this.basePath);
      if (res) return res;
      if (this.basePath.startsWith('.')) {
        const res2 = await tryLoad('/data');
        if (res2) return res2;
      }
    } catch (err) {
      console.warn(`[DataLoader] Real data for ${siteId} not present. Running on procedural engine.`, err);
    }

    return { isReal: false, siteId };
  }
}
