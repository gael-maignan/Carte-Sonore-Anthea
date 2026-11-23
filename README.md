# 🎧 Carte sonore

Deux pages web statiques (GitHub Pages) et un worker Cloudflare. Les sons sont stockés dans un **dossier Google Drive public**, et leurs infos dans une **Google Sheet publique** placée dans ce même dossier.

```
carte-sonore/
├── index.html          → carte sonore publique (lecture des sons)
├── admin.html          → ajout / modification / suppression des sons
├── config.js           → URLs et clé API utilisées par les deux pages
├── apps-script/
│   └── Code.gs         → "pont Drive" à coller dans Google Apps Script
└── worker/
    ├── worker.js       → worker API "carte-sonore-api"
    └── wrangler.toml   → optionnel, pour déployer avec Wrangler
```

## Fonctionnement (authentification hybride)

```
admin.html ──(mot de passe)──► carte-sonore-api (worker)
                                 ├─ compte de service (JWT) ─────────► Google Sheet  (lecture / écriture des lignes)
                                 ├─ secret partagé ─► Apps Script ───► ouvre une session d'envoi Drive / met à la corbeille
                                 └─ envoi du fichier audio ──────────► Google Drive (session ouverte par l'Apps Script)
index.html ──► carte-sonore-api /list   (lecture de la Sheet)
           └─► stream.gael-maignan.workers.dev/?id=…&key=…   (lecture du son)
```

**Pourquoi pas tout en compte de service ?** Depuis le 15 avril 2025, Google ne donne aucun espace de stockage Drive aux nouveaux comptes de service. Une tentative d'envoi dans un dossier « Mon Drive » renvoie l'erreur `Service Accounts do not have storage quota`. Seul un Drive partagé (Google Workspace, payant) le permettrait.

La solution retenue :
- **Le compte de service gère la Google Sheet.** Modifier une feuille partagée avec lui ne consomme aucun stockage.
- **Un petit Apps Script, exécuté sous votre compte, ouvre les sessions d'envoi Drive.** Les fichiers vous appartiennent donc. L'audio lui-même est envoyé par le worker directement à Google, sans passer par Apps Script, ce qui évite ses limites de taille.

Personne ne se connecte à Google depuis les pages. Il n'y a ni OAuth Playground, ni refresh token, ni écran de consentement à publier.

---

## Étapes, dans l'ordre

### 1. Google Drive : le dossier public
1. Connectez-vous au compte Google (dédié de préférence) et allez sur <https://drive.google.com>.
2. **Nouveau → Nouveau dossier** → `Carte sonore`.
3. Clic droit sur le dossier → **Partager → Partager** → *Accès général* : **Tous les utilisateurs disposant du lien**, rôle **Lecteur** → OK.
4. Ouvrez le dossier et copiez son ID depuis l'URL :
   `https://drive.google.com/drive/folders/`**`1AbCdEfGh…`** → c'est **FOLDER_ID**.

### 2. Google Sheet : dans ce même dossier
1. Dans le dossier : **Nouveau → Google Sheets → Feuille de calcul vierge**. Nommez-la `Carte sonore – données`.
2. Renommez l'onglet du bas `Feuille 1` en **`Sons`** (double-clic sur l'onglet).
3. **Laissez la feuille vide** : le worker écrit lui-même la ligne d'en-tête au premier ajout :
   `id | titre | description | duree | duree_s | latitude | longitude | fichier | type | date_ajout | lien_drive`
4. Vérifiez **Partager** : *Tous les utilisateurs disposant du lien – Lecteur* (c'est hérité du dossier).
5. Copiez l'ID depuis l'URL :
   `https://docs.google.com/spreadsheets/d/`**`1XyZ…`**`/edit` → c'est **SPREADSHEET_ID**.

> ⚠ Ne modifiez pas la colonne `id` à la main : c'est l'ID du fichier Drive, il relie la ligne au son. Vous pouvez en revanche corriger un titre ou une description directement dans la feuille.

### 3. Google Cloud : projet et API
1. Allez sur <https://console.cloud.google.com/> (avec le même compte).
2. En haut, sélecteur de projet → **Nouveau projet** → `carte-sonore` → Créer, puis sélectionnez-le.
3. **API et services → Bibliothèque** : activez **Google Sheets API** (pour le compte de service) et **Google Drive API** (pour la clé de lecture des sons).

### 4. Créer le compte de service et sa clé
1. Dans le projet `carte-sonore` : **IAM et administration → Comptes de service → + Créer un compte de service**.
2. Nom : `carte-sonore-worker` → **Créer et continuer**. **N'attribuez aucun rôle** (inutile) → **Continuer → OK**.
3. Notez son adresse e-mail, du type `carte-sonore-worker@carte-sonore-123456.iam.gserviceaccount.com`.
4. Cliquez sur le compte → onglet **Clés → Ajouter une clé → Créer une clé → JSON → Créer**. Un fichier `.json` se télécharge.
   > Ce fichier est un mot de passe. Ne le mettez jamais sur GitHub. Il ira uniquement dans un secret Cloudflare (étape 8).
   >
   > **Si la création de clé est bloquée** (« Key creation is not allowed on this service account ») : la règle d'administration `iam.disableServiceAccountKeyCreation` est active, ce qui arrive sur certains comptes récents. Allez dans **IAM et administration → Règles d'administration**, cherchez *Disable service account key creation*, **Gérer la règle → Remplacer la règle parente → Désactivé (Off)** → Enregistrer. Il faut le rôle « Administrateur des règles d'administration » ; sur un compte personnel sans organisation, cette règle n'existe normalement pas.

### 5. Partager la Google Sheet avec le compte de service
1. Ouvrez la Google Sheet → **Partager**.
2. Collez l'e-mail du compte de service, rôle **Éditeur**, décochez **Envoyer une notification** → **Partager**.
   > Pas besoin de lui partager le dossier Drive : il ne touche qu'à la feuille.

### 6. Créer l'Apps Script « pont Drive »
1. Avec **le compte Google propriétaire du dossier**, allez sur <https://script.google.com> → **Nouveau projet** → renommez-le `Carte sonore – Drive`.
2. Remplacez tout le contenu de `Code.gs` par celui de **`apps-script/Code.gs`** → 💾 Enregistrer.
3. À gauche, **Services → + → Drive API → Ajouter** (cela active l'API Drive pour le script).
4. ⚙ **Paramètres du projet** → en bas, **Propriétés du script → Ajouter une propriété** :

   | Propriété | Valeur |
   |---|---|
   | `SECRET` | une longue chaîne aléatoire, ex. générée sur <https://www.random.org/strings/> (32 caractères ou plus) |
   | `FOLDER_ID` | l'ID du dossier Drive (étape 1) |

5. Revenez à l'éditeur, choisissez la fonction **`testerConfiguration`** dans la liste → **▶ Exécuter**.
   Google demande des autorisations → choisissez votre compte → « Google n'a pas validé cette application » → **Paramètres avancés → Accéder à Carte sonore – Drive (non sécurisé)** → **Autoriser**.
   Le journal d'exécution doit afficher le nom du dossier et votre adresse e-mail.
6. **Déployer → Nouveau déploiement** → ⚙ type **Application Web** :
   - Description : `v1`
   - **Exécuter en tant que : Moi** (votre adresse)
   - **Qui a accès : Tout le monde**
   → **Déployer** → copiez l'**URL de l'application Web** (elle se termine par `/exec`) → c'est **APPS_SCRIPT_URL**.

   > « Tout le monde » est nécessaire pour que le worker puisse l'appeler. Sans le `SECRET`, l'Apps Script refuse toute action. Il ne peut agir que sur les fichiers de ce dossier.
   >
   > Si vous modifiez le code plus tard : **Déployer → Gérer les déploiements → ✏️ → Version : Nouvelle version → Déployer**. L'URL reste la même.

### 7. Clé API pour la lecture des sons
1. Console Google Cloud → **API et services → Identifiants → + Créer des identifiants → Clé API**.
2. Cliquez sur la clé → **Restrictions relatives aux API → Restreindre la clé** → cochez uniquement **Google Drive API** → Enregistrer.
   (Laissez « Restrictions relatives aux applications » sur **Aucune** : c'est le worker de streaming, pas le navigateur, qui appelle Google.)
3. Copiez la clé → `GOOGLE_API_KEY` dans `config.js`.
   > Cette clé est visible dans la page publique, c'est normal. Restreinte à Drive API, elle ne permet que de lire des fichiers déjà publics.

### 8. Cloudflare : le worker API
1. <https://dash.cloudflare.com> → **Workers & Pages → Créer → Worker** (« Hello World ») → nom : **`carte-sonore-api`** → Déployer.
2. **Modifier le code** → remplacez tout par le contenu de `worker/worker.js` → **Déployer**.
3. **Paramètres → Variables et secrets → + Ajouter** :

   | Nom | Type | Valeur |
   |---|---|---|
   | `SPREADSHEET_ID` | Texte | ID de la Sheet (étape 2) |
   | `SHEET_NAME` | Texte | `Sons` |
   | `ALLOWED_ORIGINS` | Texte | `https://VOTRE-PSEUDO.github.io` (sans chemin ni `/` final ; ajoutez `,http://localhost:8000` pour tester en local) |
   | `MAX_UPLOAD_MB` | Texte | `50` |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | **Secret** | **tout le contenu** du fichier `.json` de l'étape 4 (ouvrez-le avec un éditeur de texte, copiez de `{` à `}`) |
   | `APPS_SCRIPT_URL` | **Secret** | URL `/exec` de l'étape 6 |
   | `APPS_SCRIPT_SECRET` | **Secret** | la même valeur que `SECRET` dans l'Apps Script |
   | `ADMIN_PASSWORD` | **Secret** | mot de passe long de votre choix pour admin.html |

   > Si vous aviez déjà créé `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` ou `FOLDER_ID` dans le worker, supprimez-les : ils ne servent plus. L'ID client OAuth et l'écran de consentement ne sont plus nécessaires non plus.

4. Déployez, puis testez dans le navigateur :
   `https://carte-sonore-api.VOTRE-SOUS-DOMAINE.workers.dev/health?deep=1`
   → `serviceAccount`, `sheet` et `appsScript` doivent tous afficher `ok`.

   *Variante Wrangler :* remplissez `worker/wrangler.toml`, puis `npx wrangler secret put …` pour chaque secret et `npx wrangler deploy`.

> L'ancien worker « sheet + proxy audio » de votre projet précédent n'est plus nécessaire. Le worker `stream` existant est réutilisé tel quel.

### 9. GitHub : les pages
1. Créez un dépôt (ex. `carte-sonore`) et déposez `index.html`, `admin.html`, `config.js` (et le dossier `worker/` si vous voulez le versionner : il ne contient aucun secret).
2. Modifiez **`config.js`** :
   - `API_URL` : `https://carte-sonore-api.VOTRE-SOUS-DOMAINE.workers.dev`
   - `GOOGLE_API_KEY` : clé de l'étape 7
   - `SHEET_URL` : `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`
   - `DRIVE_FOLDER_URL` : `https://drive.google.com/drive/folders/FOLDER_ID`
   - `MAP_TITLE`, `MAP_CENTER`, `MAP_ZOOM` selon votre projet
3. **Settings → Pages → Build and deployment → Deploy from a branch** → `main` / `(root)` → Save.
4. Après une minute :
   - carte : `https://VOTRE-PSEUDO.github.io/carte-sonore/`
   - admin : `https://VOTRE-PSEUDO.github.io/carte-sonore/admin.html`

### 10. Premier test
1. Ouvrez `admin.html` → mot de passe (`ADMIN_PASSWORD`).
2. Glissez un MP3. La durée est calculée automatiquement. Saisissez un titre, cliquez sur la carte (ou cherchez une adresse), puis **Ajouter le son**.
3. Vérifiez que le fichier apparaît dans le dossier Drive et la ligne dans la Sheet.
4. Ouvrez `index.html` : le marqueur est là, et **▶ Écouter** lance le son.

---

## Utilisation de la page admin
- **Ajouter** : fichier, titre, description, position (clic sur la carte, marqueur déplaçable, coordonnées saisies à la main ou recherche d'adresse).
- **Modifier** : cliquez sur un son de la liste ou sur un marqueur bleu. Vous pouvez changer le titre, la description et la position (glissez le marqueur orange).
- **Supprimer** : en mode modification. La ligne est retirée de la feuille et le fichier va dans la **corbeille** du Drive (il reste récupérable 30 jours).
- Pour **remplacer un fichier audio** : supprimez le son, puis ajoutez-le à nouveau.

La carte publique accepte un lien direct vers un son : `index.html?son=ID_DU_FICHIER`.

## Limites et sécurité
- **Taille des fichiers :** 50 Mo par défaut. Le plan gratuit de Cloudflare limite une requête à 100 Mo et la mémoire du worker à 128 Mo, donc ne dépassez pas ~80 Mo. Préférez le MP3 ou le M4A au WAV.
- **Mot de passe :** il circule en HTTPS et reste en mémoire dans l'onglet (sessionStorage) jusqu'à sa fermeture. Choisissez-en un long. Pour le changer, modifiez le secret `ADMIN_PASSWORD`.
- **Clé du compte de service :** si elle fuit, supprimez-la (Comptes de service → Clés → 🗑) puis créez-en une nouvelle (étape 4.4). Elle ne donne accès qu'à la feuille partagée.
- **Secret Apps Script :** pour le changer, modifiez la propriété `SECRET` et la variable `APPS_SCRIPT_SECRET` en même temps.
- **Couper l'accès Drive :** archivez le déploiement Apps Script (Déployer → Gérer les déploiements → Archiver).
- **Actualisation :** la liste publique est mise en cache 15 s par le worker, donc un nouveau son peut mettre quelques secondes à apparaître sur la carte.
- **Recherche d'adresse :** elle utilise Nominatim (OpenStreetMap), un service gratuit à usage modéré.

## Dépannage
| Symptôme | Cause probable |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON invalide` | Le contenu du `.json` a été mal collé : il faut tout le fichier, de `{` à `}`. |
| `Compte de service refusé par Google : invalid_grant` | La clé a été supprimée ou désactivée : créez une nouvelle clé JSON (étape 4.4) et remplacez le secret. |
| `Google Sheets (403) … partagée en Éditeur avec …` | La Sheet n'est pas partagée avec l'e-mail du compte de service (étape 5). |
| `Google Sheets (403) … has not been used in project` | Google Sheets API n'est pas activée dans le projet du compte de service (étape 3). |
| `Onglet "Sons" introuvable` | Renommez l'onglet ou changez `SHEET_NAME`. |
| `Réponse inattendue de l'Apps Script` | L'URL ne se termine pas par `/exec`, ou le déploiement n'est pas en accès « Tout le monde ». |
| `Apps Script : Secret incorrect` | `APPS_SCRIPT_SECRET` et la propriété `SECRET` sont différents. |
| `Apps Script : Drive 403 … Drive API has not been used` | Ajoutez le service Drive API dans l'Apps Script (étape 6.3), puis redéployez une nouvelle version. |
| `Service Accounts do not have storage quota` | Vous utilisez une ancienne version du worker. Celle-ci n'envoie plus rien avec le compte de service. |
| « Worker injoignable » dans l'admin | `API_URL` est faux, ou l'origine GitHub Pages manque dans `ALLOWED_ORIGINS`. |
| Le son ne se lit pas | `GOOGLE_API_KEY` est absent ou mal restreint, ou le dossier n'est pas partagé « Tous les utilisateurs disposant du lien ». |
