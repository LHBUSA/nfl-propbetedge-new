# propbetedge-nfl-auth deploy receipts

Every production promotion, newest last. Versions are uploaded by `scripts/deploy-nfl-auth.mjs` (tag = git commit).

| promoted (UTC) | git commit | Worker version | rollback version | note |
|---|---|---|---|---|
| 2026-09-26T01:14:23Z | 0e96f9b (bundle-identical to 43b456c) | cc9136e3-1bd9-42d8-9934-d205f99b1114 | d75f1980-9bf3-4b75-ada0-9f01fb7401ec | reconstructed: untagged upload; 2026-09-26 audit bundled 43b456c and it matched production byte-for-byte |
| 2026-09-26T15:31Z | 57995f8 (worker source 5a00eb6) | 2f3ff437-989d-4360-8177-f22b3846f354 | cc9136e3-1bd9-42d8-9934-d205f99b1114 | v7.4 email sign-off; tagged upload via scripts/deploy-nfl-auth.mjs; 0% header-override canary 14/14 identical; post-deploy bundle parity 685/685 |
