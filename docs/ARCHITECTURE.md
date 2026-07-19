# Muh Agent — Güvenli ürün mimarisi

## 1. Ürün sınırı

Muh Agent bir “her şeye yetkili bot” değildir. Dört ayrı katmanı vardır:

1. **Bağlantı katmanı:** Gmail/Drive, yüklenen belgeler ve resmi kaynaklar.
2. **Kanıt katmanı:** Kaynak URL'si, belge hash'i, alınma zamanı, çıkarılan alanlar ve güven seviyesi.
3. **Ajan katmanı:** Özet, sınıflandırma, son tarih, öneri ve taslak üretir; hukuki/sağlık bilgisinde kaynak göstermeden kesin hüküm vermez.
4. **İşlem katmanı:** Ödeme, e-posta gönderimi, resmi başvuru ve hesap yetkisi için insan onayı, yeniden doğrulama ve audit kaydı gerekir.

Bu ayrım Kimi sürümündeki temel sorunu çözer: görsel bir “bağlandı/canlı” etiketi gerçek OAuth, veri akışı veya arka plan çalışmasını kanıtlamaz.

## 2. Çalışan web ve kimlik katmanı

- **Web:** React + TypeScript cockpit; statik dosyalar ve `/api/*` aynı Node sürecinden, aynı origin'den sunulur.
- **BFF:** Tarayıcı yalnızca same-origin API'yi çağırır. Supabase SDK'sı, proje anahtarı ve oturum token'ı browser bundle'ında bulunmaz.
- **Kimlik:** Supabase Auth PKCE; server request başına yeni istemci oluşturur. Token'lar host-only, HttpOnly, `SameSite=Lax` ve HTTPS'te `Secure` çerezde tutulur.
- **Veri:** Postgres + Row Level Security. Hassas içerik tarayıcı `localStorage`'ında tutulmaz.
- **Dosya:** Şifreli object storage; dosya tipi, boyutu ve zararlı içerik kontrolü.
- **E-posta:** Her hesap için ayrı Gmail OAuth; ilk faz yalnızca `gmail.readonly` ve profil e-postası. Drive ayrı ve açık kullanıcı onayı ile.
- **Worker:** Bilgisayardan bağımsız, managed scheduler + kuyruk + lease. Her mesaj için provider ID ve kullanıcı ID üzerinde idempotency.
- **LLM:** Kaynak parçaları ve çıkarım sonuçları arasındaki ilişki saklanır. Model eğitimi için kişisel veri kullanılmaz.
- **Bildirim:** Son tarih, token yenileme hatası ve kritik kaynak değişikliği için e-posta/push; bildirimin içine BSN veya tam belge gövdesi yazılmaz.

## 3. Değişmez güvenlik kuralları

- DigiD kullanıcı adı, şifre, SMS kodu veya oturum çerezi uygulamaya girmez ve saklanmaz.
- Ajan kendiliğinden para göndermez, resmi başvuru yapmaz veya üçüncü tarafa e-posta atmaz.
- Banka entegrasyonu ilk önce salt-okunur bakiye/işlem akışı olur. Ödeme başlatma ayrı bir fazdır.
- Her dış eylemden önce alıcı, tutar, IBAN/hesap, belge ve son tarih yeniden gösterilir.
- BSN, sağlık ve oturum belgeleri varsayılan olarak maskelenir; loglara ve model istemlerine ham haliyle yazılmaz.
- Resmi tavsiye yalnızca allowlist içindeki resmi alan adı ve tarihli kaynakla gösterilir.
- “%100 garanti”, “hile”, “kesin iptal” veya kaynaksız hak iddiası ürün metninde kullanılamaz.

## 4. Gmail senkronizasyon yaşam döngüsü

```text
Kullanıcı onayı
  -> OAuth authorization code
  -> sunucu token değişimi
  -> refresh token şifreli kasa
  -> provider message ID ile idempotent import
  -> eki güvenlik taraması
  -> OCR/alan çıkarımı
  -> kaynak + güven + insan incelemesi
  -> öneri / onay kuyruğu
```

Token değişiminde redirect URI tek bir üretim origin'inden üretilecek; `http`/`https` farkı ve proxy header'ları test edilecek. Refresh token hiçbir zaman frontend bundle'ına, URL'ye veya loga yazılmaz.

## 5. Bilgi ve hukuk akışı

IND, CJIB, Belastingdienst, Gemeente Waterland, Rechtspraak ve Rijksoverheid gibi kaynaklar bir “kaynak kaydı” olarak izlenir. Ajan bir sonuca şu alanları eklemeden kullanıcıya kritik öneri göstermez:

- `source_url`
- `retrieved_at`
- `effective_at` veya yayın tarihi
- konu ve yetki alanı
- çıkarım özeti
- güven seviyesi
- avukat/ebe/kurum doğrulaması gerekip gerekmediği

Kişisel IND dosyası için uygulama belge listesi ve soru hazırlığı yapabilir; sonucu avukat belirler. Hamilelikte sağlık önerileri klinik karar yerine bakım takvimi ve resmi hizmet bulma desteği olarak kalır.

## 6. Fazlar

### Faz 1 — Cockpit temeli (tamamlandı)

Gerçek/demoyu ayıran arayüz, onay merkezi, süre/kanıt modeli ve resmi kaynak allowlist'i.

### Faz 2 — Kalıcı kasa ve kimlik (kodlandı, staging doğrulaması bekliyor)

HttpOnly BFF, Supabase migration, RLS, kullanıcı profili ve audit modeli hazırdır. Ayrı staging projesinde migration/advisor ve gerçek PKCE kabul testi yayın kapısıdır. Şifreli dosya saklama ve veri dışa aktarma/silme sonraki adımdır.

### Faz 3 — Gmail/Drive (sunucu kodu hazır, dış yapılandırma bekliyor)

OAuth state, callback, AES-GCM refresh-token kasası, readonly sync, retry/backoff ve yeniden yetkilendirme modeli hazırdır. Google Cloud consent/redirect sırları ve 4 gerçek hesapla kabul testi yapılmadan canlı sayılmaz. Drive ayrı kullanıcı onayı olmadan istenmez.

### Faz 4 — Kaynak ve ajan motoru

Resmi kaynak taraması, belge/OCR, kaynaklı özet, son tarih çıkarımı, insan incelemesi.

### Faz 5 — Banka ve 24/7 operasyon

Önce salt-okunur PSD2/Tink benzeri bağlantı, sonra dar limitli ve çift onaylı ödeme başlatma; worker health check, retries, dead-letter ve alerting.
