/* ==========================================================
 * Configuration commune aux deux pages (index.html et admin.html)
 * Modifiez uniquement les valeurs ci-dessous.
 * ========================================================== */
window.CARTE_SONORE_CONFIG = {
  // URL de votre worker API (sans / final)
  API_URL: 'carte-sonore-anthea.gael-maignan.workers.dev',

  // Worker de streaming existant
  STREAM_URL: 'https://stream.gael-maignan.workers.dev/',

  // Clé API Google restreinte à "Google Drive API" (lecture des fichiers publics).
  // Fortement recommandée : sans elle, la lecture des gros fichiers et l'avance rapide marchent mal.
  GOOGLE_API_KEY: 'AIzaSyAuBrvFrNspuTAMvK1xxwqw8uDsy2j7-nM',

  // Liens affichés dans la page d'administration
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/18P3nep28Y3Er5gXcx9bEDN93RNwNlA_B-dQBr05UHTQ/edit',
  DRIVE_FOLDER_URL: 'https://drive.google.com/drive/folders/13vp0sz5R7img9BhP2stXWpwXIXcpAEvK',

  // Carte
  MAP_TITLE: 'Carte sonore',
  MAP_CENTER: [46.6, 2.4], // centre par défaut (France) si aucun son
  MAP_ZOOM: 6,

  // Doit correspondre à MAX_UPLOAD_MB du worker
  MAX_UPLOAD_MB: 50
};
