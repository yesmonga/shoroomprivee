# Showroomprivé Stock Monitor 🛒

Bot de surveillance de stock Showroomprivé avec notifications Discord et ajout automatique au panier.

## Fonctionnalités

- ✅ Interface web mobile-friendly pour gérer les produits
- ✅ Surveillance automatique du stock toutes les 60 secondes
- ✅ **Ajout automatique au panier** dès qu'une taille surveillée revient en stock
- ✅ **Notifications Discord** avec lien de checkout
- ✅ Support multi-produits
- ✅ Parsing automatique des URLs Showroomprivé
- ✅ Alerte Discord quand le token expire

## Déploiement sur Railway

1. Créer un nouveau projet sur [Railway](https://railway.app)
2. Connecter ce repo GitHub
3. Configurer les variables d'environnement :

```
DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
SRP_HEADERS=<coller tous les headers de l'app>
```

## Variables d'environnement

| Variable | Description | Requis |
|----------|-------------|--------|
| `DISCORD_WEBHOOK` | URL du webhook Discord | Oui |
| `SRP_HEADERS` | Headers complets de l'app (avec token, crm, client_num) | Oui |
| `PORT` | Port du serveur (défaut: 3000) | Non |

### Alternative (headers individuels)
```
SRP_TOKEN=0dtUS78SMH%2bKi3IUWOgFrpli...
SRP_CLIENT_NUM=67262809
SRP_CRM=iK3lJzJjQeQtTeMBH%2fMF44JCC...
```

## Utilisation

### Format d'URL Showroomprivé

```
https://www.showroomprive.com/link/product/{productId}
```

Exemple: `https://www.showroomprive.com/link/product/38450594`

### Obtenir les headers

1. Ouvrir l'app Showroomprivé sur ton téléphone
2. Intercepter une requête avec un proxy (Charles, mitmproxy, etc.)
3. Copier tous les headers de la requête
4. Les coller dans l'interface web ou la variable Railway

### Endpoints API

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/products` | GET | Liste des produits surveillés |
| `/api/products/fetch` | POST | Récupérer les infos d'un produit |
| `/api/products/add` | POST | Ajouter un produit au monitoring |
| `/api/products/:key` | DELETE | Supprimer un produit |
| `/api/config/headers` | POST | Mettre à jour les headers |
| `/health` | GET | Health check |

## Notes

- Le panier Showroomprivé a une durée de réservation de ~15 minutes
- L'authentification peut expirer - une notification Discord sera envoyée
- Le bot vérifie le stock toutes les 60 secondes par défaut
