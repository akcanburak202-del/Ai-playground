# Destruction

Tarayıcıda çalışan, gerçekçi malzeme fiziğine dayanan bir yıkım simülasyonu. Seçkin mimari yapıların
arasında serbestçe uçuyor, askerî silahlarla onları hedef alıyor ve malzemelerin gerçekte nasıl
davrandığını izliyorsunuz: beton ufalanır, çatlar, arka yüzünden kopar ve içindeki inşaat demirini
açığa çıkarır; çelik göçer, bükülür, ısınıp kızarır ve sonunda yırtılır; cam çatlar ya da zar gibi
dağılır; taşıyıcısı kesilen yapılar kademeli olarak çöker.

Ekranda görülen her sayı (krater derinliği, delinme sınırı, kalıntı hız, aşırı basınç) yayımlanmış
mühendislik modellerinden hesaplanır; gösteri için şişirilmez. Modellerin ayrıntısı
[PHYSICS.md](PHYSICS.md), mimari ve modül sözleşmeleri [DESIGN.md](DESIGN.md) dosyasındadır.

> Bu klasör, depodaki yapay zekâ karşılaştırma deneylerinin bir parçasıdır ve Claude tarafından
> yazılmıştır. Üç boyutlu model, doku, ses kaydı ya da hazır varlık kullanılmaz: geometri, dokular
> ve seslerin tamamı kodla üretilir.

## Çalıştırma

Node.js 22.18 veya üstü gerekir.

```bash
cd destruction
npm install
npm run dev            # http://127.0.0.1:5173 adresini açın
```

- `#range`, `#chapel`, `#pavilion`, `#tower`, `#temple` ile doğrudan bir sahne açılır
  (ör. `http://127.0.0.1:5173/#pavilion`).
- `?q=0|1|2` görüntü kalitesini seçer (0: telefon ve zayıf ekran kartları, 2: tam).
- `npm run build:single` her şeyi (fizik motoru dahil) tek bir HTML dosyasına paketler:
  `dist-single/destruction.html`.

## Kontroller

| Tuş | İşlev |
| --- | --- |
| Fare (tıkla: fare kilidi) | Bakış |
| W A S D, Boşluk / E, Q / Ctrl, Shift | Uçuş, yüksel, alçal, hızlı |
| Sol tık | Tetik (basılı tut: seri atış) |
| Sağ tık / Z | Nişan alma, dürbün |
| 1–8, fare tekerleği | Silah grubu / silah değiştir |
| T, orta tık | Mühimmat değiştir |
| G | Yıkım şarjı yerleştir |
| X / B | Şarjları birlikte / sırayla patlat |
| F veya Tab | Ağır çekim (×0,10) |
| C | Mermi kamerası (roket, top mermisi, bomba) |
| R | Sahneyi yeniden kur |
| H, M, V, Esc | Yardım, ses, arayüzü gizle, menü |

Telefonda sol tarafta hareket çubuğu, sağ tarafta bakış alanı ve ateş düğmeleri bulunur.

## Sahneler

| Sahne | Esin kaynağı | Malzemeler |
| --- | --- | --- |
| Test Sahası | Balistik atış poligonu | Farklı kalınlıkta betonarme duvarlar, S355 ve RHA plakalar, yük altında HEB kolon, IPE kiriş, üç tür cam, tuğla, granit |
| Işık Kilisesi | Tadao Ando, Ibaraki 1989 | Brüt beton (ahşap kalıp izi, kalıp bağı delikleri), duvarı kesen ışık haçı, eğik serbest duvar |
| Barselona Pavyonu | Mies van der Rohe, 1929 | Traverten podyum, ince betonarme çatı, krom haç kesitli çelik kolonlar, oniks ve yeşil mermer duvarlar, cam |
| Çelik Kule | Çelik iskeletli ofis yapısı | HEB kolonlar, IPE kirişler, çapraz bağlar, betonarme döşemeler, temperli cam giydirme cephe |
| Dor Tapınağı | Klasik Yunan tapınağı | Tambur tambur örülmüş yivli mermer sütunlar, arşitrav, triglif, alınlık |

## Silahlar

M4A1, M249 SAW, M240B, PKM, M2HB .50, Barrett M107, M134 Minigun, GAU-8/A Avenger, M320 40 mm,
RPG-7V2, Carl Gustaf M4, FGM-148 Javelin, 120 mm tank topu (APFSDS, HEAT-MP, HE-OR, HESH),
M777 155 mm obüs (dolaylı atış), JDAM hava saldırısı (GBU-38 ve BLU-109 sığınak delici),
C4 ve doğrusal kesici şarj. Mühimmat verileri (kütle, çap, namlu çıkış hızı, dolgu) açık
kaynaklardaki yayımlanmış değerlerdir.

## Fizik, kısaca

- **Dış balistik:** yerçekimi, Mach'a bağlı sürükleme, roket itkisi.
- **Beton ve taş:** değiştirilmiş NDRC delinme denklemi, Kennedy delinme ve kabuk atma sınırları,
  hasar birikimi (hasarlı beton daha kolay delinir, bu yüzden aynı noktaya atılan seri derinleşir),
  voksel tabanlı krater, tünel ve arka yüz kopması; inşaat demiri çentiklenir, kesilir, eğilir.
- **Çelik:** Lambert–Jonas ve Recht–Ipson (küçük çaplar), Lanz–Odermatt ve Tate (uzun çubuk
  delicileri), oyuk dolgulu (HEAT) jet; plakalar ve kirişler XPBD ile elasto-plastik olarak
  modellenir, plastik iş sıcaklığa dönüşür.
- **Patlama:** Kingery–Bulmash eğrileri, şok dalgasının varış süresi (camlar dışa doğru genişleyen
  bir halka hâlinde kırılır), basınç–itki hasar eğrileri, Gurney ve Mott parça modeli.
- **Yapı:** mesnetler, yük akışı, ezilme ve burkulma kontrolleri, kademeli göçme.

## Geliştirme

```bash
npm run typecheck      # TypeScript denetimi
npm test               # birim testleri (balistik kalibrasyonu, voksel, çelik, cam, yapı …)
node scripts/shot.ts "index.html#chapel" --out .shots/chapel.png   # başsız ekran görüntüsü
```

`scripts/shot.ts`, sayfayı başsız Chromium'da açıp `window.__sim` betik arayüzüyle (atış, patlatma,
zamanı ilerletme) senaryo çalıştırabilir; ayrıntılar dosyanın başındadır. Her modülün kendi deneme
sayfası `sandbox/` klasöründedir.

---

## English

A browser sandbox where you bring military weapons to celebrated-looking architecture and watch
the materials fail the way real materials fail. Concrete chips, cracks, spalls and exposes its
rebar under sustained rifle fire; steel dents, bends, heats and tears; glass cracks or dices;
buildings lose their supports and collapse progressively. Every number comes from a published
engineering model (NDRC/Kennedy, Lambert–Jonas, Recht–Ipson, Lanz–Odermatt, Tate,
Kingery–Bulmash, Gurney/Mott) — see [PHYSICS.md](PHYSICS.md); architecture and module contracts
are in [DESIGN.md](DESIGN.md).

Stack: TypeScript, Three.js r186 (WebGL2 + post-processing), Rapier 3D (WASM rigid bodies), Vite.
Everything visual and audible is generated procedurally; no asset files.

```bash
cd destruction && npm install && npm run dev      # then open http://127.0.0.1:5173/#chapel
npm test                                          # unit tests incl. ballistic calibration
npm run build:single                              # one self-contained HTML file
```
