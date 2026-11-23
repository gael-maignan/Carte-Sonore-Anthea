/**
 * Carte sonore – Apps Script "pont Drive"
 * ----------------------------------------
 * À créer sur https://script.google.com AVEC LE COMPTE PROPRIÉTAIRE DU DOSSIER DRIVE.
 * Déployé en "Application Web", exécuté sous ce compte : les fichiers audio lui appartiennent
 * (et utilisent son espace de stockage), ce qu'un compte de service ne peut plus faire.
 *
 * Il ne fait que deux choses, sur demande du worker (protégé par un secret partagé) :
 *   - createUploadSession : ouvre une session d'envoi Drive dans le dossier de la carte
 *                           (le worker envoie ensuite lui-même le fichier à Google) ;
 *   - trash               : met à la corbeille un fichier, uniquement s'il est dans ce dossier.
 *
 * Propriétés du script (Paramètres du projet > Propriétés du script) :
 *   SECRET     = une longue chaîne aléatoire (la même que APPS_SCRIPT_SECRET dans le worker)
 *   FOLDER_ID  = ID du dossier Drive public de la carte sonore
 */

var PROPS = PropertiesService.getScriptProperties();
var ALLOWED_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba)$/i;

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = PROPS.getProperty('SECRET');
    if (!secret) return out_({ ok: false, code: 'config', error: 'Propriété SECRET non définie dans l\'Apps Script' });
    if (req.secret !== secret) return out_({ ok: false, code: 'unauthorized', error: 'Secret incorrect (APPS_SCRIPT_SECRET ≠ SECRET)' });

    switch (req.action) {
      case 'ping': return out_(ping_());
      case 'createUploadSession': return out_(createUploadSession_(req));
      case 'trash': return out_(trash_(req));
      default: return out_({ ok: false, code: 'bad_action', error: 'Action inconnue : ' + req.action });
    }
  } catch (err) {
    var msg = String((err && err.message) || err);
    var notFound = /not found|introuvable|No item with the given ID|Aucun élément/i.test(msg);
    return out_({ ok: false, code: notFound ? 'not_found' : 'error', error: msg });
  }
}

function doGet() {
  return out_({ ok: true, service: 'carte-sonore-drive', info: 'Utiliser POST depuis le worker.' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function folderId_() {
  var id = PROPS.getProperty('FOLDER_ID');
  if (!id) throw new Error('Propriété FOLDER_ID non définie dans l\'Apps Script');
  return id;
}

function ping_() {
  var folder = DriveApp.getFolderById(folderId_());
  return {
    ok: true,
    folder: folder.getName(),
    sharing: String(folder.getSharingAccess()) + '/' + String(folder.getSharingPermission()),
    owner: Session.getEffectiveUser().getEmail()
  };
}

function createUploadSession_(req) {
  var name = String(req.name || 'audio').slice(0, 180);
  var mime = String(req.mimeType || '');
  var size = Number(req.size);
  if (!/^audio\//.test(mime) && !ALLOWED_EXT.test(name)) throw new Error('Type de fichier non audio : ' + mime);
  if (!(size > 0)) throw new Error('Taille de fichier invalide');

  var res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size)
      },
      payload: JSON.stringify({ name: name, mimeType: mime, parents: [folderId_()] }),
      muteHttpExceptions: true
    }
  );
  if (res.getResponseCode() !== 200) {
    throw new Error('Drive ' + res.getResponseCode() + ' : ' + res.getContentText().slice(0, 300));
  }
  var headers = res.getAllHeaders();
  var location = headers.Location || headers.location;
  if (!location) throw new Error('Drive n\'a pas renvoyé d\'URL de session');
  return { ok: true, uploadUrl: location };
}

function trash_(req) {
  var id = String(req.id || '');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error('Identifiant invalide');
  var file = DriveApp.getFileById(id);
  var parents = file.getParents(), inFolder = false, target = folderId_();
  while (parents.hasNext()) { if (parents.next().getId() === target) inFolder = true; }
  if (!inFolder) throw new Error('Refusé : ce fichier n\'est pas dans le dossier de la carte sonore');
  file.setTrashed(true);
  return { ok: true };
}

/**
 * À exécuter UNE FOIS depuis l'éditeur (bouton ▶ Exécuter) pour donner les autorisations
 * et vérifier la configuration. Le résultat s'affiche dans le journal d'exécution.
 */
function testerConfiguration() {
  Logger.log(JSON.stringify(ping_()));
  var about = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  Logger.log(about.getContentText());
}
