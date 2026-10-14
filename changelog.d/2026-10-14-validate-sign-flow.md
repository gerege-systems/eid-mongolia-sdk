- **`validateSign(result, digest, opts?)` — `expectedFlowType`** (`ValidateSignOptions { hashAlgorithm?, expectedFlowType? }`).
  Гуравдах параметр нь `hashAlgorithm` мөр (хуучин хэлбэр, хэвээр) эсвэл объект. Өгвөл хариуны `flowType` ЯГ таарах ёстой,
  эс бөгөөс `validateAuth`-тай ижил `ValidationError` (`flowType X ≠ эхлүүлсэн урсгал Y (relay байж болзошгүй)`).
  Сонголтгүй бол одоогийн зан. Яагаад: demo PDF device-link/push урсгалд flowType-ийг гараар тулгаж байсан.
  RAW_DIGEST_SIGNATURE-д `flowType` гарын үсэгт ордоггүй — хариуны тулгалт, криптограф баталгаа биш.
- Шалгасан: `npm run lint`, `npm test` (69 тест; шинэ 1).
