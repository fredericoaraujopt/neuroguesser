// Static dataset credits for Settings → About & data credits (W2 "social").
// GENERATED from neuroguesser-content/content/datasets/*.yaml: every dataset that pool.yaml enables and whose
// dataset file is not `blocked` (Fish1 is blocked today), in pool.yaml order. `attribution` and
// `licence` are copied verbatim from the dataset file (each dataset's required credit line); `url` is the DOI
// of its first `role: dataset` paper. Regenerate when a dataset file changes; do not hand-edit the entries.
// Shape: { dataset_id, name, release, species, attribution, licence, citation, url }.
export const CREDITS = Object.freeze([
  {"dataset_id": "flywire_fafb_v783", "name": "FlyWire FAFB", "release": "v783", "species": "Drosophila melanogaster", "attribution": "Data: FlyWire Consortium. Dorkenwald et al. 2024, Schlegel et al. 2024, Matsliah et al. 2024 (Nature); Berg et al. 2026, Tastekin et al. 2026 (Cell). EM: Zheng et al. 2018 (Cell). Annotations CC-BY-NC 4.0; Zenodo files CC-BY 4.0.", "licence": "CC-BY-NC 4.0 (FlyWire annotations); CC-BY 4.0 (Zenodo files)", "citation": "Dorkenwald et al. 2024, Nature", "url": "https://doi.org/10.1038/s41586-024-07558-y"},
  {"dataset_id": "male_cns_v1_0", "name": "Male CNS", "release": "v1.0", "species": "Drosophila melanogaster", "attribution": "Data: FlyEM Project Team (HHMI Janelia) with the University of Cambridge, MRC LMB and Google Research; Berg et al. 2026, Cell. CC-BY 4.0.", "licence": "CC-BY 4.0", "citation": "Berg et al. 2026, Cell", "url": "https://doi.org/10.1016/j.cell.2026.08.015"},
  {"dataset_id": "banc_v888", "name": "BANC", "release": "v888", "species": "Drosophila melanogaster", "attribution": "Data: BANC brain-and-nerve-cord connectome (Bates, Phelps, Kim, Yang et al. 2026, Nature; Harvard Dataverse deposit). CC-BY 4.0.", "licence": "CC-BY 4.0", "citation": "Bates et al. 2026, Nature", "url": "https://doi.org/10.1038/s41586-026-10735-w"},
  {"dataset_id": "manc_v1_2_1", "name": "MANC", "release": "v1.2.1", "species": "Drosophila melanogaster", "attribution": "Data: FlyEM Project Team (HHMI Janelia), Cambridge Drosophila Connectomics Group and Google Connectomics; Takemura et al. 2024, Marin et al. 2024, Cheong et al. 2026 (eLife). CC-BY.", "licence": "CC-BY", "citation": "Takemura et al. 2024, eLife", "url": "https://doi.org/10.7554/eLife.97769"},
  {"dataset_id": "optic_lobe_v1_1", "name": "Optic lobe (FlyEM)", "release": "v1.1", "species": "Drosophila melanogaster", "attribution": "Data: FlyEM Project Team (HHMI Janelia) and Google Connectomics; Nern et al. 2025, Nature. CC-BY.", "licence": "CC-BY", "citation": "Nern et al. 2025, Nature", "url": "https://doi.org/10.1038/s41586-025-08746-0"},
  {"dataset_id": "l1_larva", "name": "L1 larval CNS", "release": "CATMAID project 1 (Winding et al. 2023)", "species": "Drosophila melanogaster", "attribution": "Data: L1 larval CNS ssTEM volume (Cardona lab, HHMI Janelia), hosted by Virtual Fly Brain; Winding et al. 2023, Science; Ohyama et al. 2015, Nature. CC-BY 4.0.", "licence": "CC-BY 4.0", "citation": "Winding et al. 2023, Science", "url": "https://doi.org/10.1126/science.add9330"},
  {"dataset_id": "microns_minnie65", "name": "MICrONS cubic millimeter", "release": "v1300 (cell types v1412)", "species": "Mus musculus", "attribution": "Data: MICrONS Consortium (Allen Institute, Princeton, Baylor), www.microns-explorer.org; MICrONS Consortium 2025, Elabbady et al. 2025, Schneider-Mizell et al. 2025 (Nature). CC-BY 4.0.", "licence": "CC-BY 4.0", "citation": "MICrONS Consortium 2025, Nature", "url": "https://doi.org/10.1038/s41586-025-08790-w"},
  {"dataset_id": "h01", "name": "H01", "release": "2021-06-01 release (c3, proofread_104)", "species": "Homo sapiens", "attribution": "Data: Lichtman Lab (Harvard University) and Connectomics at Google, H01 release; Shapson-Coe et al. 2024, Science. CC-BY 4.0.", "licence": "CC-BY 4.0", "citation": "Shapson-Coe et al. 2024, Science", "url": "https://doi.org/10.1126/science.adk4858"},
  {"dataset_id": "efish_ell", "name": "efish ELL", "release": "roi450um_published_260420", "species": "Gnathonemus petersii", "attribution": "Data: Sawtell lab (Columbia University) with the Lichtman lab (Harvard University) and Connectomics at Google; Perks et al. 2026, Nature. Zenodo deposit CC-BY 4.0.", "licence": "CC-BY 4.0 (Zenodo deposit)", "citation": "Perks et al. 2026, Nature", "url": "https://doi.org/10.1038/s41586-026-10690-6"},
  {"dataset_id": "j0251_areax", "name": "j0251 Area X", "release": "v8 cell types (2026-09-23)", "species": "Taeniopygia guttata", "attribution": "Data: Kornfeld lab (MPI for Biological Intelligence; MRC LMB) with Google Research and MIT; SyConn, syconn.esc.mpcdf.mpg.de; Rother et al. 2025, bioRxiv (preprint CC-BY 4.0). No data licence stated.", "licence": "none stated for the data; the data page asks to cite Rother et al. 2025 (preprint CC-BY 4.0)", "citation": "Rother et al. 2025, bioRxiv", "url": "https://doi.org/10.1101/2025.10.25.684569"},
].map((c) => Object.freeze(c)));

/** Credits for the attribution footer: software and fonts shipped with the app. */
export const SOFTWARE_CREDITS = Object.freeze([
  Object.freeze({ name: 'Preact', licence: 'MIT', url: 'https://preactjs.com' }),
  Object.freeze({ name: 'htm', licence: 'Apache-2.0', url: 'https://github.com/developit/htm' }),
  Object.freeze({ name: 'three.js', licence: 'MIT', url: 'https://threejs.org' }),
  Object.freeze({ name: 'meshoptimizer decoder', licence: 'MIT', url: 'https://github.com/zeux/meshoptimizer' }),
  Object.freeze({ name: 'Figtree', licence: 'SIL OFL 1.1', url: 'https://github.com/erikdkennedy/figtree' }),
  Object.freeze({ name: 'Geist Mono', licence: 'SIL OFL 1.1', url: 'https://github.com/vercel/geist-font' }),
]);

export default CREDITS;
