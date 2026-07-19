# Üretime geçiş kapıları

Canlı etiketi yalnızca aşağıdaki kanıtların tamamı üretildiğinde kullanılabilir. Sırlar git'e, browser bundle'ına veya proje `.env` dosyasına yazılmaz.

## 1. Değişiklik kalite kapısı

```powershell
npm.cmd ci
npm.cmd run verify
docker build --tag muh-agent:verify .
```

- Lint, TypeScript, production build, birim/güvenlik testleri, PostgreSQL 17 migration entegrasyon testi ve Playwright masaüstü+mobil testleri geçmeli.
- `npm audit --audit-level=high` sıfır high/critical bulgu vermeli.
- Docker konteyneri non-root kullanıcıyla başlamalı; `/health` ve `/api/session` smoke testleri geçmeli.
- `git diff` ve sır taraması incelenmeden push yapılmamalı.

## 2. Ayrı Supabase staging

Muh Agent, başka bir ürünün Supabase projesini kullanmaz.

1. Ayrı EU staging projesini oluştur.
2. `supabase/migrations/` altındaki bekleyen migration dosyalarını zaman damgası sırasıyla uygula; daha önce uygulanmış dosyaları değiştirme.
3. Security ve Performance Advisor sonuçlarını al; kritik bulguları düzelt.
4. `gmail-oauth-start`, `gmail-oauth-callback`, `gmail-sync` ve `approval-decision` fonksiyonlarını `supabase/config.toml` içindeki JWT sınırlarıyla yayınla.
5. Auth redirect allowlist'e yalnızca staging origin ve `/auth/callback` ekle.
6. Önceden oluşturulmuş kişisel kullanıcıyla magic-link PKCE girişini doğrula; otomatik kullanıcı açılmadığını kanıtla.
7. RLS negatif testinde ikinci kullanıcı birinci kullanıcının hiçbir satırını görememeli.

Web runtime yalnızca şu tanımlayıcıları alır:

```text
APP_ORIGIN
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

Edge Function secret store değerleri:

```text
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
PUBLIC_APP_ORIGIN
TOKEN_ENCRYPTION_KEY
WORKER_CRON_SECRET
```

## 3. Gmail kabul testi

1. Google OAuth consent ekranı test kullanıcılarıyla sınırlı olmalı.
2. Authorized redirect URI, yayınlanan `gmail-oauth-callback` URL'siyle birebir aynı olmalı.
3. İlk bağlantı yalnızca `openid`, `email` ve `gmail.readonly` istemeli; Drive varsayılan kapalı olmalı.
4. Refresh token şifreli kaydedilmeli; düz token log, URL veya browser'a çıkmamalı.
5. Aynı mesaj ikinci worker çalışmasında duplicate oluşturmamalı.
6. Google erişimi iptal edilince hesap `reauth_required` durumuna geçmeli.
7. Dört hesap sınırlı paralellik ve 429/5xx backoff ile taranmalı.

## 4. Worker ve dış eylem kapısı

- Scheduler bilgisayar kapalıyken de çalışmalı ve son başarılı tarama zamanı ilerlemeli.
- Worker çağrısı yalnızca secret store'daki cron sırrıyla kabul edilmeli.
- Üç kalıcı başarısızlık audit/dead-letter ve kullanıcı uyarısı üretmeli.
- Onay kararı yalnızca `approved` durumunu ve audit olayını atomik kaydeder; ödeme/e-posta/resmi başvuru yürütmez.
- Gelecekteki yürütme worker'ı alıcı, tutar, hedef ve onay süresini yeniden doğrulamadan çalışamaz.

## 5. Kontrollü üretim yayını

Staging'deki aynı imaj digest'i üretime terfi ettirilir. Yayın sonrası `/health`, `/api/session`, giriş, dashboard RLS, Gmail bağlan/iptal ve audit smoke testleri tekrarlanır. Başarısız kapıda önceki imaja geri dönülür; uygulanmış migration değiştirilmez, ileri düzeltme migration'ı yazılır.
