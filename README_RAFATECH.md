# Cryptex Bank V11 — RafaTech Payments

## Nouveau
- page `merchant-payments.html`
- demandes de paiement RafaTech
- autorisation/refus par le client Cryptex
- vérification du solde courant
- débit automatique après autorisation
- historique bancaire `merchant_payment`
- retour automatique du statut à RafaTech
- identifiant de transaction `CTX-...`

## Important
Ajoute le bloc contenu dans `firestore-merchant-payments.rules.txt`
à tes règles Firestore existantes du projet Cryptex.

Cette intégration est conçue pour la simulation et non pour de vrais paiements.
