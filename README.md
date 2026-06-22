# XSD → UML · Visualiseur de schémas

Application web **100 % locale** — aucune installation, aucun `npm install`, aucune connexion
Internet — qui transforme un dossier de fichiers `.xsd` en un **grand diagramme UML interactif**
(héritage + associations), avec recherche, mode **focus**, déplacement libre des entités,
**liaison** entre plusieurs entités et **export Excel**.

> Pensée pour de gros corpus (≈ 400 fichiers, types répétés d'un fichier à l'autre).
> Les types portant le même nom sont **fusionnés** automatiquement.

> **Aucune dépendance externe.** Tout le code (parsing, layout, rendu, export) tient dans
> `index.html` + `styles.css` + `app.js`. Rien n'est téléchargé : il suffit de cloner le dépôt.

---

## Sommaire

- [Lancer l'application](#-lancer-lapplication)
- [Utilisation](#-utilisation)
- [Interactions souris](#%EF%B8%8F-interactions-souris)
- [Liaison entre entités](#-liaison-entre-entités)
- [Légende des couleurs](#-légende-des-couleurs)
- [Ce qui est extrait des XSD](#-ce-qui-est-extrait-des-xsd)
- [Performances](#-performances)
- [Export Excel](#-export-excel)
- [Détails techniques](#%EF%B8%8F-détails-techniques)

---

## 🚀 Lancer l'application

### A. Le plus simple — double-clic

Ouvrez **`index.html`** dans **Google Chrome** ou **Microsoft Edge** (recommandés).
Cliquez sur **📁 Choisir un dossier** et sélectionnez le dossier contenant vos `.xsd`.

> En `file://`, le navigateur utilise le sélecteur de dossier classique (récursif : les
> sous-dossiers sont inclus automatiquement).

### B. Servi en local (sélecteur de dossier « natif » + meilleures perfs)

Depuis le dossier du projet :

```powershell
# Avec Python (si installé)
python -m http.server 8000
# …puis ouvrir http://localhost:8000
```

ou toute autre méthode pour servir des fichiers statiques (extension VS Code « Live Server », etc.).
En `http://localhost`, l'app utilise l'API moderne `showDirectoryPicker` (sélection de dossier native).

---

## 🧭 Utilisation

| Zone | Rôle |
|------|------|
| **📁 Choisir un dossier** (panneau gauche) | Charge **tous** les `.xsd` du dossier et de ses sous-dossiers. |
| **🔎 Recherche** | Filtre la liste des entités en direct (`/` pour focus rapide). |
| **Liste des entités** | Clic sur une ligne → **centre** l'entité dans le canvas + ouvre ses détails. |
| **🔍 (à côté du nom)** | **Focus héritage** : n'affiche que l'entité, **toutes ses sous-classes** (récursif), **toute sa chaîne d'héritage** et les entités reliées par association. |
| **Canvas central** | Zoom molette, déplacement de la vue, **⤢ Ajuster** pour tout voir. |
| **Panneau détails (droite)** | Chaîne d'héritage cliquable, sous-classes, **propriétés propres + héritées**, associations, fichiers source. |

### Cases à cocher (barre du haut)

Les trois cases pilotent **à la fois la vue globale et le focus**, et leur état s'adapte
automatiquement au mode pour rester fluide :

- **Associations** : affiche les liens d'association (propriété → autre entité) **et** les entités
  voisines reliées par association. C'est le poste le plus lourd (beaucoup de traits) ; sur un gros
  focus, laisser cette case décochée garde l'affichage fluide (on ne voit alors que l'arbre d'héritage).
- **Propriétés** : affiche les compartiments de propriétés dans chaque boîte.
- **Enums** : affiche les énumérations comme nœuds dédiés et leurs liens (eux aussi multiplient les traits).

**Comportement automatique :**

- **Vue globale** : **toutes les cases sont décochées** — on ne voit que les entités (boîtes + héritage).
  C'est l'aperçu le plus léger et le plus lisible d'ensemble.
- **Focus** (en entrant) : les cases sont **re-cochées selon la taille du corpus** —
  **peu d'entités** (≤ ~120) → **tout coché** (propriétés, enums, associations) ;
  **beaucoup d'entités** → **Propriétés seule** (enums et associations, lourds, restent activables à la demande).
- Cocher / décocher une case **recadre la vue** (retour à l'affichage cadré de l'état courant).

> Vider le panier de liaison (« vider ») ramène à la **vue globale** (toutes cases décochées).

### Profondeur

Le curseur **Profondeur** limite le nombre de niveaux de sous-classes affichés (`20` = sans limite, noté `∞`).
Plus la profondeur est basse, plus le diagramme reste léger.

---

## 🖱️ Interactions souris

La souris suit un modèle volontairement non standard, pensé pour la manipulation d'un grand plan :

| Action | Effet |
|--------|-------|
| **Clic gauche (glisser) sur le vide** | **Déplace la vue** (pan), comme un cliquer-glisser classique. |
| **Clic gauche (glisser) sur une entité** | **Déplace l'entité.** Si plusieurs entités sont sélectionnées, **tout le groupe** se déplace ensemble. |
| **Clic gauche sur une entité** (sans glisser) | Sélectionne l'entité et ouvre ses détails. |
| **Clic droit (glisser)** | Trace une **zone de sélection** (rubber-band). Au relâchement, les entités touchées s'**ajoutent** à la sélection. **Plusieurs zones se cumulent** (on n'efface pas la sélection précédente). |
| **Ctrl/⌘ + clic** (ou **Maj + clic**) | **Ajoute / retire** une entité de la sélection de liaison (sur le canvas ou dans la liste). |
| **Molette** | Zoom centré sur le curseur. |
| **Double-clic sur une entité** | Entre en **focus héritage**. |

> Le **clic gauche** déplace (la vue, ou l'entité survolée) ; la sélection de texte / le drag natif
> du navigateur est désactivé sur le canvas. La **sélection** multiple se fait au **clic droit** (zone, cumulable)
> ou au **Ctrl/⌘ + clic**. Pour retirer une entité : Ctrl/⌘ + clic dessus, ou la croix ✕ dans le panier.

Le déplacement des entités est **temporaire** : il sert à mieux lire un plan. Dès qu'on
**re-focus**, qu'on relance une **liaison** ou qu'on change la profondeur, les positions
reviennent à leur disposition calculée.

---

## 🔗 Liaison entre entités

Permet de répondre à la question « **comment ces entités sont-elles reliées ?** ».

Trois façons de constituer la sélection (le **panier « Entités à relier »** s'affiche en haut du
panneau gauche dès qu'une entité est sélectionnée) :

- **Depuis la liste (panneau gauche)** — recommandé : cherchez une entité (p. ex. `signal`),
  cliquez sur le bouton **🔗** de sa ligne ; elle s'ajoute au panier en surbrillance. Cherchez la
  suivante (`voie`), cliquez **🔗**, etc. Le panier reste visible même quand la recherche masque les lignes.
- **Ctrl/⌘ + clic** sur une entité (dans la liste **ou** sur le canvas) : l'ajoute / la retire du panier.
- **Zone de sélection** au **clic droit glissé** sur le canvas — plusieurs zones se **cumulent**,
  ce qui permet d'ajouter des groupes entiers d'entités.

Puis cliquez sur **Relier**. Pour retirer une entité : la croix **✕** sur sa puce dans le panier,
ou **Ctrl/⌘ + clic** dessus. Le bouton **⬇ Excel** exporte la liaison (voir [Export Excel](#-export-excel)).

L'app calcule les **plus courts chemins** entre les entités choisies (à travers l'héritage **et** les
associations) et n'affiche que le **sous-graphe de connexion** : les entités sélectionnées (surlignées
en vert) plus toutes les entités intermédiaires nécessaires pour les relier.

Exemple : sélectionner *Signal* et *Voie* montre par quelles entités/associations on passe pour aller de
l'un à l'autre — utile pour vérifier qu'un schéma relie bien les concepts attendus. Si deux entités ne
sont **pas** connectées, un bandeau le signale (et reste affiché tant qu'on est sur cette liaison).

> Les **types « conteneur »** (types-document qui ne font que lister des références, p. ex. un
> `…s` au pluriel) peuvent être une **extrémité** de liaison, mais ne servent jamais d'**intermédiaire** :
> sinon presque toutes les entités seraient reliées trivialement en passant par le même conteneur.

---

## 🎨 Légende des couleurs

La légende (en bas à gauche du canvas) est toujours visible et rappelle la signification des couleurs.

- **Couleur d'une entité = sa famille d'héritage.** Toutes les classes qui partagent la même
  **racine d'héritage** reçoivent la même couleur. Les couleurs proviennent d'une palette fixe,
  attribuée famille par famille (ce n'est donc **pas** aléatoire : une même couleur = une même famille).
- **Arête orange (pleine, flèche triangulaire)** : héritage / généralisation (*est-un*).
- **Arête bleue (pointillés)** : association (une propriété pointe vers une autre entité).
- **Arête violette (pointillés fins)** : lien vers une énumération.
- **Surbrillance** : entité sélectionnée / extrémités d'une liaison.

---

## 🔍 Ce qui est extrait des XSD

- **Entités** : chaque `xs:complexType` nommé (fusionné par nom entre fichiers).
- **Héritage** : `xs:complexContent` / `xs:extension|restriction` → relation *est-un* (généralisation UML).
- **Propriétés** : `xs:element` et `xs:attribute` (nom, type, cardinalité `minOccurs..maxOccurs`, `nillable`),
  y compris les types anonymes imbriqués (le lien vers le type interne est conservé).
- **Associations** : une propriété dont le type pointe vers un autre `complexType`.
- **Énumérations** : `xs:simpleType` / `xs:restriction` / `xs:enumeration`.
- **Classes abstraites** : `abstract="true"`.

---

## ⚡ Performances

Le rendu est optimisé pour les très gros graphes, **sans aucune librairie** :

- **Arêtes regroupées** : toutes les arêtes d'un même type sont fusionnées en un seul tracé SVG
  (flèches incluses dans la géométrie), ce qui réduit énormément le nombre d'éléments DOM.
- **Niveau de détail (LOD) des nœuds** : quand on dézoome, les compartiments de propriétés (illisibles à
  petite échelle) ne sont plus rendus — en dessous d'un certain zoom, une entité n'est qu'un bloc coloré.
- **LOD des arêtes** : au zoom éloigné, les traits sont rendus **pleins et fins, sans pointillés ni
  flèches** (ce sont les pointillés/flèches sur des milliers de courbes qui coûtent le plus cher).
- **Culling** : seules les entités visibles dans la fenêtre courante sont montées dans le DOM
  lorsqu'on est zoomé ; le déplacement de la vue ne recalcule rien tant qu'on reste dans la zone rendue.
- **Cases adaptatives** : la vue globale n'affiche que les entités, et un gros focus n'active pas les
  associations/enums par défaut — ce sont les traits (associations, liens d'enums) qui font ramer.

Résultat : un focus profond (p. ex. `ObjetPersistant`, ~380 descendants) reste fluide, même associations activées.

---

## 📊 Export Excel

- **⬇ Excel (complet)** : classeur multi-feuilles — *Entités, Propriétés (propres + héritées), Héritage, Associations, Énumérations*.
- **⬇ Excel (focus)** (panneau détails) : une entité, ses propriétés (avec origine d'héritage), sa chaîne d'héritage + descendants, ses associations.
- **⬇ Excel (liaison)** (panier « Entités à relier ») : pour les entités reliées, un classeur —
  *Liaison* (paires reliées ou non + chemin), *Chemins (détail)* (chaque saut et sa relation),
  *Entités du graphe*, *Associations* du sous-graphe.

> Les fichiers `.xlsx` générés (OOXML natif, sans librairie) s'ouvrent **directement** dans Excel /
> LibreOffice, sans avertissement « le format et l'extension ne correspondent pas ».

> **Chaque feuille est un vrai « Tableau » Excel** (objet *ListObject*) : les colonnes ont des
> **menus de filtre/tri** prêts à l'emploi et un style à bandes. (Une feuille sans aucune ligne de
> données reçoit un simple filtre automatique d'en-tête plutôt qu'un objet Tableau, qu'Excel
> refuserait.)

---

## ⚙️ Détails techniques

- **Aucune librairie externe.** Parsing via `DOMParser`, rendu via DOM + SVG, export `.xlsx` (OOXML)
  via un mini-packer ZIP + CRC32 écrits en JavaScript natif.
- **Performance** : lecture/parsing par lots avec barre de progression ; layout hiérarchique calculé une
  fois et mis en cache ; rendu avec batching d'arêtes, LOD et culling (voir [Performances](#-performances)).
- **Compatibilité** : Chromium (Chrome / Edge) recommandé. Firefox fonctionne via le sélecteur de dossier classique.

### Fichiers

```
index.html    structure de la page
styles.css    thème + mise en page
app.js        parseur XSD, modèle, layout, rendu, focus, liaison, export
```
