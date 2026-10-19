### Tests — `convert-e2e`: Linux WebKit-д цуцалсны дараах дахин хувиргалтыг алгасахаа болив

- **Юу:** `scripts/convert-e2e.mjs`-ийн Linux WebKit-ийн алгасалт (2026-10-15-наас — terminate хийсэн worker-ийн дараа шинэ
  worker-ийн LibreOffice init дуусдаггүй гэж) хасагдсан; цуцлалт → дахин хувиргалт (кэшээс) + verbose лог бүх хөтөчид шалгагдана.
- **Яагаад:** шалтгаан нь 0.21.0-ийн `pthreadPoolSize` 4 → 8 засвартай ижил deadlock байсан.
- **Шалгасан:** PR #43-ийн CI `convert-e2e (webkit)` — «цуцалсны дараа: download үе шатгүй (кэш), 2507 ms», wasm/data дахин татаагүй.
