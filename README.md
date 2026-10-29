# Suivi des devis

Site de suivi des devis par événement : besoins, propositions des fournisseurs (concurrence et versions V1, V2…), étapes à cocher, factures et mémoire des prix.

- **Page** : `public/index.html`
- **Serveur** : `api/` (fonctions Vercel, sans dépendance à installer)
- **Données et PDF** : Supabase (gratuit)
- **Accès** : un mot de passe d'équipe, vérifié par le serveur. Chaque navigateur le retient ensuite pendant un an.

## Mise en ligne

### 1. Supabase (5 minutes)
1. Crée un compte sur supabase.com, puis **New project**. Choisis la région **Paris (eu-west-3)**.
2. Va dans **SQL Editor** → **New query**, colle tout le contenu de `supabase/setup.sql`, puis **Run**. Recommence avec `supabase/migration-2.sql`.
3. Va dans **Project Settings** → **API Keys** et récupère :
   - l'**URL du projet** (`https://xxxx.supabase.co`) ;
   - la **clé secrète** (`sb_secret_…`), ou à défaut la clé `service_role` de l'onglet « Legacy ».

   Cette clé donne accès à tout : ne la colle que dans Vercel, nulle part ailleurs.

### 2. Vercel
1. **Add New** → **Project** → importe ce dépôt GitHub. Aucun réglage de build n'est à changer.
2. Avant de lancer le déploiement, ouvre **Environment Variables** et ajoute :

| Nom | Valeur |
| --- | --- |
| `APP_PASSWORD` | `LGS` |
| `SUPABASE_URL` | l'URL du projet Supabase |
| `SUPABASE_SERVICE_KEY` | la clé secrète Supabase |

3. **Deploy**. Le site est en ligne à l'adresse donnée par Vercel.

Pour changer le mot de passe plus tard, il suffit de modifier `APP_PASSWORD` dans Vercel puis de redéployer. Tout le monde devra alors retaper le nouveau mot de passe.

## Mises à jour de la base
- **29/10/2026** : `supabase/migration-2.sql` (fiches événement, numéros de besoin attribués par la base). À exécuter une fois dans **SQL Editor**. Sans elle, le site fonctionne mais sans dates, lieu ni notes d'événement.

## Comment ça marche
- Les changements des autres apparaissent tout seuls, avec un rafraîchissement toutes les 15 secondes.
- Les PDF sont rangés dans un dossier privé de Supabase. Le site ne les ouvre qu'aux personnes connectées.
- Fichiers acceptés : PDF, PNG, JPEG, WebP, jusqu'à 20 Mo.
- **Corbeille** : un besoin, une proposition ou un événement supprimé y reste 30 jours, puis est effacé avec ses PDF.
- **Tâche quotidienne** (`/api/daily`, 5h17 UTC) : vide la corbeille et garde le projet Supabase actif (le plan gratuit se met en pause après 7 jours sans activité).
- **Export** : en bas de page, « Exporter pour Excel » (une ligne par proposition) et « Sauvegarde complète » (tout le contenu, en JSON). Pense à faire une sauvegarde de temps en temps.
