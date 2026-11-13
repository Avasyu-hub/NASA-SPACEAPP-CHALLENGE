/**
 * Real Data Ingestion Pipeline.
 * Ingests precomputed NASA LOLA DEM binary heightmaps and JPL Horizons ephemerides.
 * Auto-detects real offline files; falls back to synthetic if files are not yet generated.
 */

export class DataLoader {
  constructor(basePath = './data') {
    this.basePath = basePath;
    this.availableSites = [
      { id: 'site04', name: 'Shackleton Rim (Connecting Ridge)', lat: -89.9, lon: 129.0 },
      { id: 'site01', name: 'Site 01 (De Gerlache Rim)', lat: -88.5, lon: -68.7 },
      { id: 'site07', name: 'Site 07 (Malapert Massif Peak)', lat: -85.9, lon: -2.9 },
      { id: 'site11', name: 'Site 11 (Haworth Crater Rim)', lat: -87.4, lon: -5.1 },
      { id: 'site23', name: 'Site 23 (Amundsen Crater Rim)', lat: -84.5, lon: 85.6 },
    ];
  }

  /**
   * Attempts to load master site registry
   */
  async loadSites() {
    try {
      const resp = await fetch(`${this.basePath}/sites.json`);
      if (resp.ok) {
        this.availableSites = await resp.json();
        return { isReal: true, sites: this.availableSites };
      }
    } catch {
      // Fallback
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
    try {
      const [anglesResp, maskResp, resultsResp, hmMetaResp] = await Promise.all([
        fetch(`${this.basePath}/angles/${siteId}.json`),
        fetch(`${this.basePath}/mask/${siteId}.json`),
        fetch(`${this.basePath}/results/${siteId}.json`),
        fetch(`${this.basePath}/heightmap/${siteId}.json`),
      ]);

      if (anglesResp.ok && maskResp.ok && resultsResp.ok && hmMetaResp.ok) {
        const angles = await anglesResp.json();
        const mask = await maskResp.json();
        const results = await resultsResp.json();
        const hmMeta = await hmMetaResp.json();

        // Fetch binary heightmaps
        const nearBinUrl = `${this.basePath}/heightmap/${hmMeta.near.file}`;
        const farBinUrl = `${this.basePath}/heightmap/${hmMeta.far.file}`;

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
    } catch (err) {
      console.warn(`[DataLoader] Real data for ${siteId} not present. Running on procedural engine.`, err);
    }

    return { isReal: false, siteId };
  }
}
