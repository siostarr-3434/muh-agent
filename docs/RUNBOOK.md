# Muh Agent işletim runbook'u

## Sağlık kontrolü

- Web: `GET /health` yanıtı HTTP 200 ve `{ "status": "ok", "service": "muh-agent" }` olmalı.
- Oturum: `GET /api/session` yanıtta `Cache-Control: private, no-store` taşımalı; canlı ortamda `mode: "live"` görünmeli.
- Supabase: proje `ACTIVE_HEALTHY`, migration listesi güncel ve Security/Performance Advisor kritik bulgusuz olmalı.
- Gmail worker: her hesap için son başarılı tarama zamanı ilerlemeli; hata halinde e-posta adresi veya token loglanmamalı.

## Alarm eşikleri

- Web health üç ardışık kontrolde başarısız: kritik.
- Worker 30 dakikadan uzun süre başarı kaydı üretmiyor: kritik.
- OAuth `reauth_required`: uyarı; kullanıcıya yeniden bağlama gösterilir.
- Aynı worker işi üç kez başarısız: dead-letter ve insan incelemesi.

## Olay müdahalesi

1. Dış eylem worker'larını durdur; okuma ve görüntüleme erişimini mümkünse koru.
2. Son başarılı commit/deployment kimliğini ve Supabase log zaman aralığını kaydet.
3. Token veya sır sızıntısı şüphesinde ilgili sırrı döndür; loglara gerçek değeri yazma.
4. Etkilenen kullanıcı/veri kapsamını belirle.
5. Geri alma veya ileri düzeltme migration'ı uygula; uygulanmış migration dosyasını değiştirme.
6. E2E ve smoke testleri geçmeden işlemleri yeniden açma.

## Oturum olayı

- Şüpheli oturumda kullanıcıdan tarayıcı depolamasındaki token istenmez; token browser JavaScript'ine açık değildir.
- Mevcut oturum `/api/auth/signout` ile yerel olarak kapatılır. Gerekirse Supabase Auth panelinden tüm kullanıcı oturumları ayrıca iptal edilir.
- Yanlış origin, çerez veya callback davranışında `APP_ORIGIN` ve Auth redirect allowlist birebir karşılaştırılır; proxy `Host` başlığından dinamik redirect üretilmez.

## Geri alma

- Web: önceki imaj/commit'i yeniden yayınla.
- Veritabanı: yıkıcı geri alma yapma; yeni bir ileri migration ile düzelt.
- Edge Function: önceki doğrulanmış sürümü yeniden yayınla.
- OAuth: bozuk callback durumunda yeni bağlantıları kapat; mevcut refresh tokenları silmeden önce etkiyi doğrula.

## Değişmez sınır

Ödeme, e-posta gönderme veya resmi başvuru yalnızca ayrı yürütme adımında; geçerli insan onayı, yeniden doğrulama ve audit kaydıyla mümkündür. Şu anki sistem yalnızca karar kaydeder, dış eylem gerçekleştirmez.
