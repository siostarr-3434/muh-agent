# Kimi konuşmasından taşınan gereksinimler

## Kullanıcı hedefi

Hollanda'daki ceza, fatura, vergi, resmi yazışma, oturum/IND dosyası, aile ve hamilelik sürelerini tek bir kişisel operasyon merkezinden izlemek; Gmail hesaplarından gelen belgeleri sınıflandırmak; ödeme veya resmi mesaj göndermeden önce kullanıcıdan onay almak.

## Kimi sürümünde doğrulanan sınırlar

- Canlı URL HTTP 200 dönüyor ve MUHASİP React bundle'ı sunuyor.
- Bundle içinde çoğu demo durumunun `localStorage` anahtarlarıyla tutulduğu görüldü.
- E-posta ekranı oturumlu veri yoksa “Demo veri — Gmail bağlanınca gerçek akışa geçer” mesajını gösteriyor.
- Bundle'da `/api/oauth/authorize`, `/api/oauth/callback` ve `/api/trpc` yolları görülüyor; bu tek başına Gmail OAuth'un başarıyla tamamlandığını veya worker'ın 7/24 çalıştığını kanıtlamıyor.
- Kimi konuşmasındaki `67e9cd4`, `285eca9` gibi versiyon kartlarının bu çalışma alanında kaynak kodu bulunmuyor; bu nedenle onların gerçekten yayınlanan commit'ler olduğunu varsaymıyoruz.

## Korunacak kararlar

- BSN, telefon, DigiD sırları ve tam kimlik bilgileri gereksiz yere istenmeyecek.
- Hukuki ve tıbbi içerik kaynaklı, tarihli ve “uzman doğrulaması gerekli” etiketiyle gösterilecek.
- Kullanıcı “yetki veriyorum” dese bile uygulama güvenlik için dar kapsamlı izin ve kritik işlemlerde yeniden onay kullanacak.
- İlk banka fazı salt-okunur olacak.
