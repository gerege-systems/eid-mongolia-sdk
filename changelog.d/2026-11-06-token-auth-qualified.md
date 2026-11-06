### Fixed — USB токены AUTH гэрчилгээ QUALIFIED (CA !472-тэй нийцэл)

- **Юу:** `certificateLevelOf(cert, "ACSP_V2")` qcStatements-гүй нэвтрэлтийн гэрчилгээнд KeyUsage `keyEncipherment`
  (утасны P-CITIZEN-AUTH)-аас гадна **EKU clientAuth + emailProtection ба certificatePolicies-д үндэсний OID
  `2.16.496.1.101.1.2.8`** (токены P-CITIZEN-AUTH-TOKEN — EC тул KE үгүй) байвал `QUALIFIED` буцаана; өмнө нь `ADVANCED`.
  Бусад (policy-гүй, emailProtection-гүй) нэвтрэлтийн гэрчилгээ `ADVANCED` хэвээр; гарын үсгийн дүрэм (qcStatements)
  өөрчлөгдөөгүй.
- **Яагаад:** CA !472 (2026-11-06) токены AUTH/SIGN мөрийг `QUALIFIED` болгосон тул session-ий хариу токены AUTH-д
  `certificateLevel: QUALIFIED` зарлана — хуучин дүрмээр `validateAuth` «гэрчилгээнээс (ADVANCED) өндөр» гэж татгалздаг
  байв. Өмнө олгосон токены AUTH гэрчилгээ ижил агуулгатай; CA тэдгээрийг `ADVANCED` гэж зарласаар байгаа бөгөөд хариуны
  бага түвшин хүчинтэй тул RP-д `ADVANCED` хэвээр.
- **Хаана:** `src/validator.ts` (`certificateLevelOf`, `isCitizenAuthToken`, `certPolicyIds`), README §Validator 3; тест
  `test/chain.test.ts` («certificateLevel — гэрчилгээнээс» — токены AUTH fixture: KU DS, EKU clientAuth+emailProtection,
  үндэсний policy, EC P-256 → QUALIFIED; policy-гүй / emailProtection-гүй → ADVANCED). Go SDK v0.22.2-той ижил дүрэм.
- **Шалгасан:** GitHub CI (`npm run lint`, `npm test`).
