# Muh Agent çalışma sözleşmesi

Bu depo kişisel finans, resmi belge ve sağlıkla ilişkili hassas veriler içerir. Her değişiklikte aşağıdaki sınırlar geçerlidir:

- Canonical çalışma dizini `C:\Users\Siyabent\Muh Agent` adresidir.
- Mimari veya ajan akışı değişikliklerinde `agent-architecture-audit` ve `agent-harness-construction` kullan.
- Auth, OAuth, RLS, sırlar, dosya veya para akışında `security-review`; şema değişikliğinde `database-migrations` ve `supabase-postgres-best-practices` kullan.
- React değişikliklerinde proje içindeki `vercel-react-best-practices`; kullanıcı akışlarında `e2e-testing` kullan.
- Tamamlandı demeden önce `npm run verify` çalıştır ve gerçek çıktıyı raporla.
- Ajan para göndermez, e-posta yollamaz, resmi başvuru yapmaz ve DigiD sırrı istemez. Kritik dış eylem ayrı insan onayı, yeniden doğrulama ve audit olayı gerektirir.
- `service_role`, Google client secret, worker secret, token şifreleme anahtarı veya kişisel erişim tokenı frontend'e, git'e ya da proje `.env` dosyasına yazılmaz.
- Klinik projesi `hair-roots-nlbe` ile Muh Agent veritabanı, sırları ve yayın zinciri karıştırılmaz.

Üretim sırası: lint → typecheck → build → unit/security testleri → Playwright E2E → dependency audit → staging smoke test → kontrollü yayın.
