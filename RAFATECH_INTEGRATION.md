# RafaTech ↔ Cryptex Bank

## Fonctionnement

1. Le client prépare sa commande sur RafaTech.
2. Il renseigne l'adresse e-mail de son compte Cryptex Bank.
3. RafaTech crée une demande dans la collection Cryptex :
   `merchantPaymentRequests`.
4. Le client ouvre Cryptex Bank → **Achats**.
5. Cryptex affiche la demande RafaTech avec le montant TTC.
6. Le client choisit **Autoriser** ou **Refuser**.
7. En cas d'autorisation :
   - Cryptex vérifie le compte courant ;
   - Cryptex débite le montant ;
   - une transaction `CTX-...` est créée dans l'historique bancaire ;
   - la demande passe à `approved`.
8. RafaTech détecte automatiquement `approved`.
9. RafaTech crée alors la commande avec :
   - `paymentMethod: "Cryptex Bank"`
   - `paymentStatus: "Payé via Cryptex Bank"`
   - `cryptexPaymentRequestId`
   - `cryptexTransactionId`
10. L'administrateur RafaTech voit la commande et peut ensuite l'accepter/refuser.
11. Le stock est retiré uniquement lors de l'acceptation de la commande par l'admin RafaTech.

## Important : règles Firestore Cryptex

Le fichier :
`firestore-merchant-payments.rules.txt`

contient le bloc à AJOUTER aux règles existantes du projet Firebase Cryptex
`fake-bank-b6e00`.

Ne remplace pas toutes tes règles actuelles : insère uniquement le bloc `match /merchantPaymentRequests/...`
dans le `match /databases/{database}/documents`.

Sans ce bloc, RafaTech ne pourra probablement pas créer/lire les demandes.

## Test

Le compte utilisé dans Cryptex Bank doit avoir exactement la même adresse que celle saisie dans RafaTech.

Exemple :

RafaTech :
`client@test.fr`

Cryptex Bank :
connexion avec `client@test.fr`

Puis :
Cryptex → **Achats** → Autoriser.

## Sécurité

Cette intégration relie deux projets Firebase directement depuis le navigateur parce qu'il s'agit d'une simulation.

Elle ne doit pas être utilisée avec de l'argent réel :
un vrai système nécessiterait un backend ou des Cloud Functions pour créer, signer et confirmer les paiements.
