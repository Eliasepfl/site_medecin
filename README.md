# Flux de patients hors patientèle

Petit site statique (GitHub Pages) qui calcule, à partir de deux PDF, le nombre de
**patients distincts facturés sur une période qui ne figurent pas dans la patientèle
médecin traitant**, avec un tableau de bord des factures.

## Confidentialité

- Les PDF sont lus **dans le navigateur** ; aucun fichier n'est envoyé.
- Aucun serveur, aucun cookie, aucun stockage local : fermer ou recharger l'onglet efface tout.
- La page interdit elle-même toute connexion sortante (`Content-Security-Policy: connect-src 'none'`),
  et la bibliothèque de lecture des PDF (pdf.js) est copiée dans `vendor/` : rien n'est chargé depuis un autre site.

GitHub n'héberge que le code de la page. Ne jamais ajouter de PDF ni d'export dans ce dépôt.

## Utilisation

1. Ouvrir le site et déposer le journal des factures et la liste complète de patientèle
   (plusieurs fichiers possibles, le type est reconnu automatiquement).
2. Vérifier la période (par défaut à partir du 01/01/2024, c'est-à-dire « depuis le 31/12/2023 »).
3. Lire le chiffre principal ; la liste des patients hors patientèle peut être exportée en CSV.

## Méthode

- **Factures** : une ligne = date, libellé (`NOM FV numéro`), patient, montant, dû, payé, NIR.
- **Patientèle** : une ligne = nom prénom, âge, NIR (13 chiffres), date d'entrée, ALD, régime.
- Les NIR sont comparés sur leurs 13 premiers chiffres (la clé de contrôle est ignorée).
- Deux factures concernent le même patient si elles ont le même NIR et un nom compatible
  (un même NIR peut couvrir plusieurs personnes d'une famille).
- Un patient facturé est dans la patientèle si son NIR y figure avec un nom compatible
  (ou le même prénom). Option cochée par défaut : nom et prénom identiques suffisent
  quand le NIR diffère ou manque.
- Les cas douteux sont listés dans « Rapprochements à vérifier », et les passages de PDF
  non reconnus dans « Contrôle de la lecture des PDF ».

## Publier sur GitHub Pages

Dépôt → **Settings → Pages → Build and deployment** : source « Deploy from a branch »,
branche `main`, dossier `/ (root)`. Le site est ensuite disponible à l'adresse
`https://<utilisateur>.github.io/<dépôt>/`.

## Essayer en local

Les modules JavaScript ne se chargent pas depuis `file://` ; lancer un petit serveur :

```
python -m http.server 8000
```

puis ouvrir <http://localhost:8000>.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | La page |
| `js/parse.js` | Lecture du texte des PDF (factures, patientèle) |
| `js/analyse.js` | Rapprochement des patients et indicateurs |
| `js/charts.js` | Graphiques SVG |
| `js/app.js` | Interface |
| `vendor/pdfjs/` | pdf.js (Mozilla, licence Apache 2.0) |
