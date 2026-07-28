# Cryptex Bank V12.1 — vrai compte RafaTech

Les ventes RafaTech sont maintenant créditées à deux endroits :

1. Le vrai compte utilisateur Cryptex `rafatech@cryptex.fr`
   - `accounts.courant`
   - `transactions`
   - `history`
   - `notifications`

2. `merchantAccounts/rafatech`
   - conservé pour statistiques et historique marchand global.

Important :
le compte `rafatech@cryptex.fr` doit exister dans Firebase Authentication
ET avoir un document Firestore dans `users` avec le champ :
`email: "rafatech@cryptex.fr"`
