# Cahier des charges — XSD → UML · Visualiseur de schémas

> Document de référence décrivant **précisément et exhaustivement** ce que fait l'application,
> son fonctionnement interne et ses règles métier. Destiné à comprendre tout le projet d'un coup.

---

## 1. Objectif

Transformer un dossier de fichiers **`.xsd`** (schémas XML) en un **grand diagramme UML interactif**
explorable dans le navigateur, afin de visualiser et comprendre rapidement un modèle de données
volumineux : entités (classes), héritage, associations, énumérations, propriétés — et de **vérifier
comment des entités sont reliées entre elles**.

Cas d'usage cible : gros corpus métier (≈ 400 fichiers, ~700 entités), avec des types répétés d'un
fichier à l'autre.

---

## 2. Contraintes fondamentales

| Contrainte | Détail |
|------------|--------|
| **100 % local** | Aucune connexion Internet requise. Fonctionne en `file://` (double-clic) ou servi en `http://localhost`. |
| **Zéro dépendance externe** | Aucune librairie, aucun `npm install`, rien à télécharger. Tout est en JavaScript/CSS/HTML natif. Si une dépendance devait être ajoutée, elle devrait être **embarquée dans le dépôt** (vendored), jamais chargée depuis un CDN. |
| **Traitement côté client** | Parsing via `DOMParser`, rendu DOM + SVG, export via SpreadsheetML — le tout dans le navigateur. Aucune donnée n'est envoyée à un serveur. |
| **Performance** | Doit rester fluide sur de gros graphes (centaines d'entités, milliers d'arêtes). |
| **Navigateurs** | Chromium (Chrome / Edge) recommandé. Firefox supporté via le sélecteur de dossier classique. |

### Fichiers du projet

```
index.html              structure de la page (barre d'outils, panneaux, canvas)
styles.css              thème sombre + mise en page, styles des nœuds/arêtes/panneaux
app.js                  toute la logique : parsing, modèle, layout, rendu, interactions, liaison, export
_sample/                jeu d'essai (379 fichiers .xsd) — non requis pour l'app
.claude/launch.json     config locale du serveur de preview (python http.server)
README.md               guide d'utilisation
cahier_des_charges.md   ce document
```

---

## 3. Pipeline de traitement

1. **Sélection d'un dossier** (récursive). Deux mécanismes :
   - `window.showDirectoryPicker()` (API moderne, en `http://localhost`) — sélecteur natif.
   - `<input type="file" webkitdirectory>` (repli universel, en `file://`).
2. **Lecture + parsing par lots** (14 fichiers à la fois) avec barre de progression, pour ne pas
   bloquer l'UI. Chaque `.xsd` est parsé via `DOMParser`.
3. **Construction du modèle** : extraction des `complexType`, `simpleType`, `element` globaux.
4. **Fusion globale par nom** : les types de même nom rencontrés dans plusieurs fichiers sont
   fusionnés (voir §5). On conserve la liste des fichiers source.
5. **Finalisation** : carte des enfants (héritage), couleur par famille, graphe d'adjacence
   (pour la liaison).
6. **Layout** (hiérarchique) puis **rendu** (DOM + SVG) de la vue globale.
7. **Interactions** : recherche, liste, focus, liaison, déplacement, zoom, export.

Hook de chargement sans sélecteur (debug / corpus embarqué) : `window.__loadXsdUrls([url, …])`.

---

## 4. Extraction depuis les XSD

| Élément XSD | Devient |
|-------------|---------|
| `xs:complexType` nommé | une **entité** (classe UML) |
| `xs:complexContent` / `xs:extension`\|`restriction` (`@base`) | relation d'**héritage** (généralisation *est-un*) |
| `xs:simpleContent` / `xs:extension`\|`restriction` | héritage de type simple (base scalaire) |
| `xs:element`, `xs:attribute` | **propriété** (nom, type, cardinalité `minOccurs..maxOccurs`, `nillable`, `@attr`) |
| `xs:element` global `name/type` | table `elementName → typeName` (résolution des `ref`) |
| propriété dont le type pointe vers un `complexType` | **association** |
| propriété dont le type pointe vers un `simpleType` enum | lien vers une **énumération** |
| `xs:simpleType` / `xs:restriction` / `xs:enumeration` | une **énumération** (liste de valeurs) |
| `abstract="true"` | classe **abstraite** (badge `{abstrait}`) |
| type anonyme imbriqué dans un `element` | la propriété conserve le lien vers le type interne |

**Cardinalité** : `min..max` ; `min`/`max` absents → `1` ; `maxOccurs="unbounded"` → `*`.

**Résolution de type d'une propriété** (`refTypeOf`) : on suit les `ref` et la table
`elementName → typeName` pour obtenir le nom local de l'entité/enum cible ou un type primitif.
Les types XSD intégrés (string, int, dateTime, …) sont considérés **primitifs**.

---

## 5. Modèle de données (en mémoire)

- **classes** : `Map<name, { name, abstract, base, simpleBase, props[], files:Set }>`
  - `props[]` : `{ name, rawType, isRef, min, max, nillable, attr, inline }`
- **enums** : `Map<name, { name, values[], files:Set }>`
- **elementToType** : `Map<elementName, typeName>` (résolution des références).
- **childrenMap** : `Map<parent, [enfants]>` (héritage descendant).
- **rootColor** : `Map<name, couleur>` — couleur attribuée par **racine d'héritage** (famille).
- **adjacency** : `Map<name, Set<voisins>>` — graphe **non orienté** (héritage + associations),
  utilisé par la liaison.

### Règles de fusion par nom

- **complexType** : si un type de même nom existe déjà, on **fusionne les fichiers source** ; on
  conserve la base la plus informée ; on garde la définition la plus « riche » (score = nombre de
  propriétés ×10 + base + abstrait).
- **simpleType (enum)** : **union** des valeurs ; fusion des fichiers source.

### Notions dérivées

- **ancestors(name)** : chaîne d'héritage `[parent, …, racine]`.
- **descendants(name)** : tous les sous-types (récursif).
- **rootOf(name)** : racine d'héritage (définit la famille / la couleur).
- **isContainer(name)** : type « conteneur de document » = plus d'une propriété et **toutes** sont
  des `ref` (liste de références). Traité spécialement dans la liaison (§9) et exclu des focus comme
  voisin d'association bruyant.

---

## 6. Les trois vues

### 6.1 Vue globale
- Affiche **toutes** les entités, regroupées par **famille d'héritage** (arbre « tidy-tree » par
  racine), empaquetées en étagères. Les énumérations forment une bande en bas (si activées).
- Par défaut : **toutes les cases décochées** → on ne voit que les boîtes + l'héritage (aperçu léger).
- Le layout global est calculé une fois et **mis en cache** (invalidé si Propriétés/Enums/Profondeur changent).
- Au chargement, si le graphe est trop grand pour être lisible une fois « ajusté », la vue se place
  sur la **racine de la plus grande famille**.

### 6.2 Mode focus (héritage)
- Déclenché par le bouton **🔍** (liste), **⤢** (nœud) ou **double-clic**.
- Affiche : l'entité ciblée, **toute sa chaîne d'ancêtres**, **tous ses descendants** (bornés par la
  profondeur), et — selon les cases — ses **énumérations** et ses **voisins d'association**
  (sortants depuis l'entité+descendants, entrants depuis les classes non-conteneurs qui la référencent).
- En entrant en focus, les cases sont **re-cochées selon la taille du corpus** (§8).

### 6.3 Mode liaison
- Affiche le **sous-graphe de connexion** entre 2+ entités choisies (§9). Disposition en **colonnes
  par distance** depuis la première entité. Extrémités surlignées en vert, chemins surlignés.

Le **curseur Profondeur** (0..20, `20` = ∞) borne le nombre de niveaux de sous-classes affichés
en global et en focus.

---

## 7. Interactions (souris / clavier)

Modèle souris **volontairement non standard** (manipulation d'un grand plan) :

| Geste | Effet |
|-------|-------|
| **Clic gauche glissé sur le vide** | Déplace la vue (pan). |
| **Clic gauche glissé sur une entité** | Déplace l'entité ; si plusieurs sont sélectionnées, déplace **tout le groupe**. |
| **Clic gauche sur une entité (sans glisser)** | Sélectionne l'entité + ouvre le panneau détails. |
| **Clic droit glissé** | Zone de sélection (rubber-band). Les entités touchées s'**ajoutent** ; **les zones se cumulent** (pas d'effacement de la sélection précédente). |
| **Ctrl/⌘ + clic** ou **Maj + clic** (canvas ou liste) | Ajoute / retire une entité de la sélection de liaison. |
| **Molette** | Zoom centré sur le curseur. |
| **Double-clic sur une entité** | Focus héritage. |
| **Échap** | Vide la sélection ; sinon revient au global ; sinon ferme les détails. |
| **`/`** | Place le curseur dans la recherche. |

- La sélection de texte et le drag natif du navigateur sont **désactivés** sur le canvas.
- Le **clic droit** n'ouvre pas le menu contextuel (réservé à la sélection).
- **Déplacement temporaire** : les positions déplacées **reviennent** à leur disposition calculée
  dès qu'on re-focus, relance une liaison, change la profondeur ou une case (re-layout).

---

## 8. Cases à cocher (Associations / Propriétés / Enums)

Les trois cases pilotent **global ET focus**. Effet :

- **Associations** : arêtes d'association + voisins d'association (en focus). Poste le plus lourd.
- **Propriétés** : compartiments de propriétés dans les boîtes.
- **Enums** : nœuds d'énumération + leurs arêtes.

**Comportement adaptatif (anti-lag)** :

| Transition | État des cases |
|------------|----------------|
| Chargement / retour en **vue globale** | **tout décoché** (juste les entités). |
| Entrée en **focus**, corpus **petit** (≤ 120 entités) | **tout coché** (props + enums + assoc). |
| Entrée en **focus**, corpus **grand** (> 120) | **Propriétés seule** (enums + assoc décochés, activables). |

- Cocher/décocher **recadre** la vue (retour à l'affichage cadré : `frameGlobal` en global, `fitView`
  en focus/liaison), pour revenir à un état lisible plutôt que de rester sur la position courante.
- Seuil `SMALL_CORPUS` = 120 entités (constante ajustable dans `app.js`).

---

## 9. Liaison entre entités

**But** : répondre à « comment ces entités sont-elles reliées ? » (ex. *Signal* relié à *Voie*).

### Constitution de la sélection (« panier »)
- Panier **« Entités à relier »** affiché en haut du panneau gauche dès qu'une entité est sélectionnée.
- Ajout : bouton **🔗** d'une ligne, **Ctrl/⌘ + clic** (liste ou canvas), ou **zone clic droit** (cumulable).
- Retrait : croix **✕** sur la puce, ou **Ctrl/⌘ + clic** sur l'entité.
- Le panier reste visible même quand la recherche masque les lignes correspondantes.

### Calcul
- Graphe **non orienté** = héritage + associations entre classes (tous types inclus).
- Pour chaque **paire** d'entités sélectionnées : **plus court chemin** (BFS).
- **Règle des conteneurs** : un type conteneur (`isContainer`) peut être une **extrémité** valide
  (ex. `alignement ↔ alignements`), mais le BFS **n'autorise pas à le traverser** s'il n'est pas
  sélectionné — sinon presque toutes les entités seraient reliées trivialement via le même conteneur.
- Le **sous-graphe de connexion** = union de tous les chemins ; rendu avec extrémités et chemins
  surlignés.
- Si une paire n'est **pas** connectée : un **bandeau** le signale et **reste affiché tant qu'on est
  sur cette liaison** (disparaît au changement de mode).

### Boutons du panier
- **Relier** (actif à partir de 2 entités) → affiche la liaison.
- **⬇ Excel** → exporte la liaison (§10).
- **vider** → vide le panier et revient à la vue globale.

---

## 10. Exports Excel (SpreadsheetML 2003, sans librairie)

Fichiers `.xls` ouvrables directement dans Excel / LibreOffice.

| Export | Déclencheur | Feuilles |
|--------|-------------|----------|
| **Complet** | bouton « ⬇ Excel (complet) » | Entités · Propriétés (propres + héritées) · Héritage · Associations · Énumérations |
| **Focus** | panneau détails « ⬇ Excel (focus) » | Résumé · Propriétés (avec origine) · Héritage (ancêtres + descendants) · Associations |
| **Liaison** | panier « ⬇ Excel » | Liaison (paires + chemin) · Chemins détaillés (chaque saut + relation) · Entités du graphe · Associations du sous-graphe |

---

## 11. Rendu et performances

Le rendu est conçu pour rester fluide sur de très gros graphes :

- **Arêtes regroupées (batching)** : toutes les arêtes d'un même type sont fusionnées en **un seul
  `<path>` SVG** ; les pointes de flèches sont dessinées **dans la géométrie** (pas de `<marker>`).
- **LOD des nœuds** selon le zoom : `full` (propriétés visibles) → `compact` (en-tête seul) →
  `mini` (simple bloc coloré).
- **LOD des arêtes** : au niveau `mini`, traits **pleins fins, sans pointillés ni flèches ni libellés**
  (la rastérisation de milliers de courbes pointillées est le principal facteur de lag).
- **Culling (virtualisation)** : seuls les nœuds intersectant la fenêtre courante (élargie d'une
  marge) sont montés dans le DOM. Le pan ne re-peint pas tant qu'on reste dans la zone rendue
  (mémorisée + rAF).
- **Cases adaptatives** (§8) : la vue globale n'affiche que les entités, et un gros focus n'active pas
  associations/enums par défaut, pour limiter le nombre de traits.
- **Layout en cache** : la vue globale n'est recalculée que si Propriétés/Enums/Profondeur changent.

Résultat : un focus profond (ex. `objetPersistant`, ~380 descendants) reste fluide, même associations
activées.

---

## 12. Légende et couleurs

Légende fixe en bas à gauche :
- **Couleur d'une entité = sa famille d'héritage** (même racine = même couleur ; palette fixe, **non
  aléatoire**).
- **Orange plein, flèche triangulaire** : héritage (généralisation).
- **Bleu pointillé** : association.
- **Violet pointillé fin** : lien vers une énumération.
- **Surbrillance verte** : entité sélectionnée / extrémités d'une liaison.

---

## 13. Hooks de débogage (sur `window`)

- `window.__dumpModel()` : renvoie le modèle reconstruit (classes, enums, héritage, associations) —
  vérification croisée avec les XSD.
- `window.__loadXsdUrls([url, …])` : charge des `.xsd` par URL sans passer par le sélecteur de dossier.

---

## 14. Limites connues

- Le layout d'un arbre d'héritage très large (centaines de feuilles) produit un « monde » très large ;
  c'est inhérent à la disposition en arbre (le culling/LOD garantit néanmoins la fluidité).
- Les fichiers XSD invalides (erreur de parsing XML) sont ignorés (avertissement console).
- La fusion par nom suppose qu'un même nom désigne **le même** type d'un fichier à l'autre.
