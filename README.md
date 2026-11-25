# Data Ocean

## Démarrer l’application

Node.js 22.5 ou supérieur est requis. En local, le serveur utilise le module SQLite intégré à Node.

```powershell
npm start
```

Ouvrez ensuite <http://127.0.0.1:3000>. Le serveur sert le site depuis `public/` et crée/conserve les observations dans `data-ocean.sqlite`, à la racine du projet. Pour choisir un autre emplacement, définissez la variable d’environnement `DATA_OCEAN_DB` avant de lancer le serveur.

Les observations déjà enregistrées dans le stockage du navigateur sont importées automatiquement à la première connexion à la base. Les données de démonstration restent fictives et ne sont pas enregistrées dans SQLite.

## Comptes et connexion

La page `/connexion` permet aux utilisateurs de créer un compte avec une adresse courriel et un mot de passe d’au moins 10 caractères. Les mots de passe sont hachés avec `scrypt`; les sessions expirent après 7 jours. Le tableau de bord et son API nécessitent une session active.

En local, le compte administrateur est créé ou actualisé au démarrage à partir de variables d’environnement. Définissez-les avant `npm start` :

```powershell
$env:ADMIN_EMAIL = "admin@exemple.org"
$env:ADMIN_PASSWORD = "votre-secret-administrateur-long"
npm start
```

Le mot de passe administrateur doit contenir au moins 14 caractères. Ne le placez pas dans le code source. Sans ces variables, l’inscription et la connexion des utilisateurs restent disponibles, mais aucun compte administrateur n’est configuré.

## Déploiement sur Vercel

Vercel publie les fichiers statiques de `public/` et l’API serverless dans `api/[...route].js`. Le serveur local `server.js` et sa base SQLite restent utilisés par `npm start`; en production, l’API utilise PostgreSQL.

1. Créez une base PostgreSQL, par exemple sur Neon, puis exécutez le contenu de `schema.postgres.sql` dans son éditeur SQL.
2. Dans Vercel, importez le dépôt GitHub et ajoutez les variables d’environnement `DATABASE_URL`, `ADMIN_EMAIL` et `ADMIN_PASSWORD`. Utilisez l’URL de connexion PostgreSQL fournie par le service de base de données. Le mot de passe administrateur doit contenir entre 14 et 128 caractères.
3. Déployez le projet. Vercel détecte les fonctions dans `api/`; `vercel.json` configure l’URL `/connexion`.

Les observations et comptes déjà présents dans `data-ocean.sqlite` ne sont pas transférés automatiquement vers PostgreSQL. Les variables d’environnement et les données de connexion ne doivent pas être ajoutées au dépôt.
