# RafaTech V6.1 ↔ Cryptex Bank V12

## Nouveau flux

### Quand Cryptex autorise le paiement
1. Le compte courant du client Cryptex est débité.
2. Le compte marchand `merchantAccounts/rafatech` est crédité du même montant.
3. RafaTech détecte la validation.
4. RafaTech retire immédiatement les quantités du stock.
5. La commande RafaTech est créée en attente de validation administrateur.

### Si l'admin RafaTech accepte
Le stock n'est PAS retiré une seconde fois.
La commande passe simplement à `Acceptée`.

### Si l'admin RafaTech refuse
1. Le stock retiré est automatiquement remis.
2. La commande passe à `Refusée`.
3. RafaTech affiche :
   - le montant exact à rembourser ;
   - l'adresse e-mail Cryptex du client.
4. L'admin rembourse manuellement dans Cryptex.
5. Il clique sur **Marquer remboursé**.
6. La commande refusée peut ensuite être supprimée.

## Compte marchand Cryptex RafaTech

Cryptex possède maintenant :

`merchantAccounts/rafatech`

avec notamment :
- `name: "RafaTech Entreprise"`
- `email: "rafatech@cryptex.fr"`
- `balance`
- `transactions`

Page Cryptex :
`merchant-account.html`

Cette page est réservée à un compte Cryptex administrateur.

## Règles Firebase à republier

### Projet RafaTech : `simulateur-bank`
Republie le fichier complet :

`firestore.rules`

La modification importante autorise un client connecté à uniquement **diminuer** un stock lors d'un achat payé.

### Projet Cryptex : `fake-bank-b6e00`
Ajoute aux règles existantes les blocs présents dans :

`firestore-merchant-payments.rules.txt`

Il contient maintenant :
- `merchantPaymentRequests`
- `merchantAccounts`

## Important
Ce système reste une simulation. Les écritures inter-projets sont réalisées depuis les navigateurs et ne conviennent pas à de vrais flux financiers.


## V12.1 — vrai compte Cryptex RafaTech

Le compte utilisateur `rafatech@cryptex.fr` est maintenant crédité directement.

À chaque paiement RafaTech accepté :
- client : compte courant -X €
- RafaTech Entreprise : compte courant +X €
- transaction positive ajoutée à RafaTech
- notification "Vente RafaTech reçue"

Le profil RafaTech doit exister dans `users` avec :
`email: "rafatech@cryptex.fr"`
