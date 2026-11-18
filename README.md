# Flux de patients hors patientèle

Petit site statique (GitHub Pages) qui calcule, à partir de deux PDF, le nombre de
**patients distincts facturés sur une période qui ne figurent pas dans la patientèle
médecin traitant**, avec un tableau de bord des factures.

## Confidentialité

- Les PDF sont lus **dans le navigateur** ; aucun fichier n'est envoyé.
- Aucun serveur, aucun cookie, aucun stockage local : fermer ou recharger l'onglet efface tout.
- La page interdit elle-même toute connexion sortante (`Content-Security-Policy: connect-src 'none'`),
  et la bibliothèque de lecture des PDF (pdf.js) comme la police sont copiées dans `vendor/` : rien n'est chargé depuis un autre site.

GitHub n'héberge que le code de la page. Ne jamais ajouter de PDF ni d'export dans ce dépôt.

## Utilisation

1. Ouvrir le site, déposer le journal des factures dans la zone « Factures » et la liste
   complète de patientèle dans la zone « Patientèle » (plusieurs fichiers possibles par zone).
2. Vérifier la période (par défaut à partir du 01/01/2024, c'est-à-dire « depuis le 31/12/2023 »).
3. Lire le chiffre principal ; la liste des patients hors patientèle peut être exportée en CSV.

Si un PDF est mal lu, « Un PDF est mal lu ? » permet de coller son texte, et affiche la
structure du texte lu avec chaque lettre remplacée par A et chaque chiffre par 9 : ce bloc
ne contient aucune donnée et peut être transmis pour faire corriger la lecture.

## Méthode

- **Factures** : une ligne = date, libellé (`NOM CODE numéro`, le numéro pouvant manquer), patient,
  un à trois montants (Dû et Payé peuvent être vides), NIR. Le texte est découpé à chaque date,
  quel que soit le nombre de lignes. Quand le journal mélange plusieurs codes (FV…), des cases
  permettent de choisir lesquels compter.
- Un NIR écrit à côté du nom du patient (`NOM : NIR`) sert aussi au rapprochement.
- **Patientèle** : une ligne = nom prénom, âge, NIR (13 chiffres), date d'entrée, ALD, régime.
- Les NIR sont comparés sur leurs 13 premiers chiffres (la clé de contrôle est ignorée).
- Les deux documents écrivent NOM puis PRÉNOM(S) : la facture donne tous les prénoms, la
  patientèle le premier (simple ou composé). Tirets, apostrophes et accents sont ignorés.
- Un patient facturé est dans la patientèle si son NIR y figure et que le nom de la patientèle
  est le début du nom de la facture (`DUPONT JEAN` / `DUPONT JEAN PIERRE`), ou que le nom est
  raccourci d'un côté mais suivi du même prénom (`ZOLA--ZIDANE XAVIER` / `ZOLA XAVIER LOUIS`).
  `DUPONT PAUL JEAN` avec le NIR de `DUPONT JEAN` est une autre personne (même famille).
- Même NIR, même prénom mais nom entièrement différent : rattaché, et signalé à vérifier.
- Option cochée par défaut : sans NIR commun, le nom de la patientèle en début du nom de la
  facture suffit. Option décochée par défaut : se fier au NIR seul.
- Les cas douteux sont listés dans « Rapprochements à vérifier », et les passages de PDF
  non reconnus dans « Un PDF est mal lu ? ».

## Publier sur GitHub Pages

Dépôt → **Settings → Pages → Build and deployment** : source « Deploy from a branch »,
branche `main`, dossier `/ (root)`. Le site est ensuite disponible à l'adresse
`https://<utilisateur>.github.io/<dépôt>/`.

## Essayer en local

Double-cliquer sur `index.html` suffit : la page fonctionne aussi ouverte directement
depuis le disque, sans serveur ni connexion.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | La page |
| `js/parse.js` | Lecture du texte des PDF (factures, patientèle) |
| `js/analyse.js` | Rapprochement des patients et indicateurs |
| `js/charts.js` | Graphiques SVG |
| `js/app.js` | Interface |
| `js/boot.js` | Message d'erreur si un script ne démarre pas |
| `vendor/pdfjs/` | pdf.js (Mozilla, licence Apache 2.0) |
| `vendor/fonts/` | IBM Plex Sans (licence OFL) |
