# Muh Agent

Muh Agent; para yükümlülüklerini, resmi yazışmaları, son tarihleri ve hassas belgeleri tek bir kişisel güvenlik cockpit'inde toplamak için geliştirilen approval-first uygulamadır.

## Güncel durum

Çalışan temel şunları içerir:

- React + TypeScript cockpit ve aynı origin'de çalışan Node BFF.
- Demo ile canlı veriyi açıkça ayıran çalışma modu.
- Supabase PKCE girişi; tarayıcı JavaScript'ine açılmayan HttpOnly, `SameSite=Lax`, host-only oturum çerezleri.
- Kullanıcı başına RLS, en az yetki grant'leri, atomik karar/audit ve Gmail token/audit işlemleri.
- Salt-okunur Gmail OAuth başlangıç/callback/senkronizasyon Edge Function'ları.
- Onayın dış eylemi yürütmediği ayrı karar katmanı.
- Birim, güvenlik ve gerçek Chrome masaüstü/mobil E2E testleri.
- Non-root, çok aşamalı Docker imajı ve GitHub Actions kalite kapıları.

Ayrı Supabase staging projesinde şema ve dört Edge Function yayınlandı; yetkisiz erişim smoke testleri geçti. Üretim hosting/alan adı, Google OAuth sırları, gerçek Gmail kabul testi, 24/7 scheduler, OCR ve banka bağlantısı henüz canlı değildir. DigiD otomasyonu ve otomatik ödeme ürün sınırı dışında kalır. Arayüz bu eksikleri canlıymış gibi göstermez.

## Yerel çalıştırma

Node.js `24.18+` (26'dan düşük) ile:

```powershell
npm.cmd ci
npm.cmd run dev
```

Ardından `http://127.0.0.1:5173` adresini açın. Sunucu değişkenleri yoksa uygulama güvenli demo modunda başlar.

Tüm kalite kapıları:

```powershell
npm.cmd run verify
```

## Canlı BFF yapılandırması

Bu değerler tarayıcı bundle'ına değil, yalnızca hosting platformunun runtime secret/config alanına verilir:

```text
APP_ORIGIN=https://uygulama-alan-adi.example
SUPABASE_URL=https://proje-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

`SUPABASE_SERVICE_ROLE_KEY`, Google client secret, worker secret ve token şifreleme anahtarı web konteynerine verilmez; yalnızca Supabase Edge Function secret store'unda tutulur.

Mimari ayrıntılar [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), yayın kapıları [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), olay işletimi [docs/RUNBOOK.md](docs/RUNBOOK.md) içindedir.
