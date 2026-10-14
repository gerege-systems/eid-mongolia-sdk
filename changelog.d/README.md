# changelog.d — нэг өөрчлөлт, нэг файл

`CHANGELOG.md`-г салбар/PR дотор засахгүй. Өөрчлөлт бүр `changelog.d/<YYYY-MM-DD>-<сэдэв>.md` файлд: юу · яагаад ·
хаана · хэрхэн шалгасан. CI (`changelog` job) PR бүрд фрагмент (эсвэл release нэгтгэл) шаардана.

Release (version bump-тай нэг commit): `node scripts/changelog.mjs assemble <version>` — фрагментуудыг `CHANGELOG.md`-ийн
«## <version> — <огноо>» хэсэгт оруулж файлуудыг устгана. `v<version>` tag-ийн Release workflow
`scripts/changelog.mjs check-release`-ээр фрагмент үлдээгүй, гарчиг байгааг шалгана — эс бөгөөс publish хийхгүй.
