// ============================================================
// ALAÇAM - ML TESPİTİ v2 OPTIMIZED (YERLEŞİM MASKELİ + PERFORMANS)
// ============================================================
// Yapılan Geliştirmeler:
// 1. Performans Optimizasyonu (focal_mode, chunk-based export)
// 2. Fenolojik Kurallar İyileştirmesi (NDVI, LSWI, MNDWI)
// 3. Random Forest Sınıflandırıcı Optimizasyonu
// 4. EVI İndeksi Ekleme
// 5. Negatif Örnekleme Geliştirmesi
// 6. Doğrulama Metrikleri
// 7. Parametreler Ayarlanabilir
// 8. Chunk-based Export (Timeout Çözümü)

// ========== KRİTİK PARAMETRELER ========== 
var PARAMS = {
  min_alan_donum: 0.2,
  slope_threshold: 4,
  ndvi_threshold_buyume: 0.40,
  lswi_threshold_ekim: 0.10,
  mndwi_threshold_ekim: 0.15,
  ndvi_gelisim_fark: 0.15,
  erosion_radius: 1.5,
  buffer_distance: -12,
  simplify_tolerance: 5,
  min_connected_pixels: 1,
  rf_num_trees: 200,
  rf_variables_per_split: 5,
  rf_min_leaf_population: 10,
  rf_bag_fraction: 0.8,
  positive_samples_limit: 5000,
  negative_samples_count: 3000,
  chunk_size: 500  // Export chunk size
};

// ========== VERİ HAZIRLIĞI ========== 
var celtikTarlalari = ee.FeatureCollection('projects/sincere-loader-486616-r9/assets/celtik_egitim');

var gaul = ee.FeatureCollection('FAO/GAUL_SIMPLIFIED_500m/2015/level2');
var ilce = gaul.filter(ee.Filter.and(
  ee.Filter.eq('ADM1_NAME', 'Samsun'),
  ee.Filter.eq('ADM2_NAME', 'Alacam')
));
var ilceSiniri = ilce.geometry();

print('📍 Çalışma Alanı:', ilce.first().get('ADM2_NAME'));

// ========== BULUT MASKELEME ========== 
function maskS2clouds(image) {
  var scl = image.select('SCL');
  // SCL: 4=Vegetation, 5=Non-Vegetation, 6=Water
  return image.updateMask(scl.eq(4).or(scl.eq(5)).or(scl.eq(6)));
}

// ========== SENTİNEL-2 VERİ TOPLAMA ========== 
var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(ilceSiniri)
  .filterDate('2024-05-01', '2024-09-30')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .map(maskS2clouds);

print('📊 Toplam Sentinel-2 Görüntü:', s2.size().getInfo());

// ========== KOMPOZİT OLUŞTURMA + EVI ========== 
function makeComposite(col, d1, d2, tag) {
  var med = col.filterDate(d1, d2).median();
  
  // Standart İndeksler
  var ndvi = med.normalizedDifference(['B8','B4']).rename('NDVI_'+tag);
  var lswi = med.normalizedDifference(['B8','B11']).rename('LSWI_'+tag);
  var mndwi = med.normalizedDifference(['B3','B11']).rename('MNDWI_'+tag); // Su indeksi
  
  // ✨ YENİ: EVI (Enhanced Vegetation Index)
  var evi = med.expression(
    '2.5 * (B8 - B4) / (B8 + 6*B4 - 7.5*B2 + 1)',
    {B8: med.select('B8'), B4: med.select('B4'), B2: med.select('B2')}
  ).rename('EVI_'+tag);
  
  // Spektral Bandlar
  var bands = med.select(['B3','B4','B8','B11','B12'])
    .rename(['B3_'+tag,'B4_'+tag,'B8_'+tag,'B11_'+tag,'B12_'+tag]);
  
  return bands.addBands([ndvi, lswi, mndwi, evi]);
}

var ekim   = makeComposite(s2, '2024-05-15','2024-07-05','E');
var buyume = makeComposite(s2, '2024-07-05','2024-09-15','B');

print('✅ Kompozitler oluşturuldu');

// ========== TOPOGRAFYA ========== 
var dem = ee.Image('USGS/SRTMGL1_003');
var slope = ee.Terrain.slope(dem).rename('slope');

var featureStack = ekim.addBands(buyume)
  .addBands(slope).addBands(dem.select('elevation'))
  .clip(ilceSiniri);

var bandNames = featureStack.bandNames();

// ========== ARAZI ÖRTÜSÜ ========== 
var worldcover = ee.ImageCollection('ESA/WorldCover/v200').first().select('Map');

// ========== EĞITIM VERISİ ========== 
// POZITIF: Çeltik tarlaları
var pozitifNoktalar = featureStack.sampleRegions({
  collection: celtikTarlalari.map(function(f) { return f.set('sinif', 1); }),
  properties: ['sinif'], 
  scale: 10, 
  tileScale: 16
}).limit(PARAMS.positive_samples_limit);

print('✅ Pozitif Örnekler:', pozitifNoktalar.size().getInfo());

// NEGATİF: Kesinlikle çeltik olmayan alanlar
var kesinNegatif = worldcover.eq(10)   // Orman
  .or(worldcover.eq(50))                // Yapı/Yerleşim
  .or(worldcover.eq(80))                // Su
  .or(worldcover.eq(30));               // Diğer Tarım

var negatifNoktalar = featureStack.updateMask(kesinNegatif).sample({
  region: ilceSiniri, 
  scale: 10, 
  numPixels: PARAMS.negative_samples_count, 
  seed: 42, 
  geometries: true
}).map(function(f) { return f.set('sinif', 0); });

// + Rastgele negatif örnekler
var rastgeleNegatif = featureStack.sample({
  region: ilceSiniri, 
  scale: 20, 
  numPixels: 1000, 
  seed: 123
}).map(function(f) { return f.set('sinif', 0); });

var egitimPixeller = pozitifNoktalar.merge(negatifNoktalar).merge(rastgeleNegatif);

print('✅ Negatif Örnekler:', negatifNoktalar.size().getInfo(), 
      '+ Rastgele:', rastgeleNegatif.size().getInfo());

// ========== RANDOM FOREST SINIFLANDIRICISı ========== 
var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: PARAMS.rf_num_trees,
  variablesPerSplit: PARAMS.rf_variables_per_split,
  minLeafPopulation: PARAMS.rf_min_leaf_population,
  bagFraction: PARAMS.rf_bag_fraction,
  seed: 42
}).train({
  features: egitimPixeller,
  classProperty: 'sinif',
  inputProperties: bandNames
});

print('🤖 Random Forest Sınıflandırıcısı Eğitildi');

// ========== DOĞRULAMA METRİKLERİ ========== 
var trainAccuracy = classifier.confusionMatrix();
print('📊 Confusion Matrix:', trainAccuracy);
print('📈 Accuracy:', trainAccuracy.accuracy());
print('🎯 Kappa:', trainAccuracy.kappa());

// ========== SINIFLANDIRMA ========== 
var siniflandirma = featureStack.classify(classifier);
var celtikTespit = siniflandirma.eq(1);

print('✅ Sınıflandırma tamamlandı');

// ========== YERLEŞİM + SU + ORMAN MASKELEME ========== 
var yerlesim = worldcover.eq(50);  // Binalar
var su = worldcover.eq(80);         // Su
var orman = worldcover.eq(10);      // Orman

// Eğim Maskelesi (Çeltik tarlaları çok düz olmalı)
var duzAlan = slope.lt(PARAMS.slope_threshold);

// ========== FENOLOJIK DOĞRULAMA İYİLEŞTİRİLMİŞ ========== 
// 1. Ekim Dönemi: Su Şartı (LSWI > 0.10 VEYA MNDWI > 0.15)
var ekimSu = ekim.select('LSWI_E').gt(PARAMS.lswi_threshold_ekim)
  .or(ekim.select('MNDWI_E').gt(PARAMS.mndwi_threshold_ekim));

// 2. Büyüme Dönemi: Yeşillik Şartı (NDVI > 0.40)
var buyumeYesil = buyume.select('NDVI_B').gt(PARAMS.ndvi_threshold_buyume);

// ✨ YENİ: EVI Şartı (EVI > 0.35)
var buyumeEVI = buyume.select('EVI_B').gt(0.35);

// 3. Gelişim Şartı: Hızlı Büyüme (NDVI farkı > 0.15)
var gelisim = buyume.select('NDVI_B')
  .subtract(ekim.select('NDVI_E'))
  .gt(PARAMS.ndvi_gelisim_fark);

// Fenoloji kombinasyonu
var fenoloji = ekimSu.and(buyumeYesil).and(buyumeEVI).and(gelisim);

// Temiz Maske
var temizMaske = yerlesim.or(su).or(orman).not()
  .and(duzAlan)
  .and(fenoloji);

print('✅ Fenolojik Maskeleme Tamamlandı');

// ========== MORFOLOJIK OPERASYONLAR İYİLEŞTİRİLMİŞ ========== 
// 1. focal_mode ile daha hızlı ve etkili işlem
var celtikTemiz = celtikTespit.updateMask(temizMaske)
  .focal_mode({radius: PARAMS.erosion_radius, kernelType: 'circle'})
  .selfMask();

// 2. Küçük/Hatalı Parçaları Silme
var pixelSayisi = celtikTemiz.connectedPixelCount(50, true);
celtikTemiz = celtikTemiz.updateMask(pixelSayisi.gt(PARAMS.min_connected_pixels));

// 3. Son Maskeleme
celtikTemiz = celtikTemiz.selfMask();

print('✅ Morfolojik İşlemler Tamamlandı');

// ========== ALAN HESABI ========== 
var alanPixel = celtikTemiz.multiply(ee.Image.pixelArea());
var toplamAlan = alanPixel.reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: ilceSiniri, 
  scale: 30, 
  maxPixels: 1e13
});

var toplamAlanDonum = ee.Number(toplamAlan.values().get(0)).divide(1000);
print('🌾 TOPLAM ÇELTİK ALANI:', toplamAlanDonum.getInfo(), 'dönüm');

// ========== HARİTA ========== 
Map.centerObject(ilceSiniri, 12);
Map.addLayer(ee.Image().byte().paint({featureCollection: ilce, color: 1, width: 3}),
  {palette: 'FF0000'}, 'İlçe Sınırı');
Map.addLayer(celtikTemiz, {palette: ['00ff00'], opacity: 0.5}, '🌾 Çeltik (ML v2)');
Map.addLayer(fenoloji, {palette: ['0000FF'], opacity: 0.3}, '📊 Fenoloji Maske');

// ========== VEKTÖR OLUŞTURMA ========== 
var celtikVector = celtikTemiz.reduceToVectors({
  geometry: ilceSiniri, 
  scale: 10, 
  maxPixels: 1e13,
  geometryType: 'polygon', 
  eightConnected: false, 
  bestEffort: true,
  labelProperty: 'sinif',
  tileScale: 8
});

print('✅ Vektör Oluşturma Tamamlandı');

// ========== GEOMETRİ İYİLEŞTİRME ========== 
celtikVector = celtikVector.map(function(f) {
  f = ee.Feature(f);
  return f.buffer(PARAMS.buffer_distance)
    .simplify(PARAMS.simplify_tolerance)
    .buffer(0, 5)
    .simplify(3);
});

// MultiPolygon → Tekil Polygon
celtikVector = celtikVector.map(function(f) {
  return ee.FeatureCollection(f.geometry().geometries().map(function(g) {
    return ee.Feature(ee.Geometry(g)).copyProperties(f);
  }));
}).flatten();

// ========== ÖZELLİKLER EKLEME ========== 
celtikVector = celtikVector.map(function(f) {
  var alan = f.geometry().area(10).divide(1000); // Dönüm  
  
  // NDVI Hesaplama (isteğe bağlı, performans için devre dışı)
  var ndvi = 0; // Hız için kaldırıldı  
  
  return f.set({
    'name': ee.String('Tarla_').cat(ee.String(f.id())),
    'description': ee.String('Alan: ').cat(alan.format('%.2f')).cat(' dönüm'),
    'Alan_Donum': alan,
    'NDVI_Avg': ndvi
  });
}).filter(ee.Filter.gt('Alan_Donum', PARAMS.min_alan_donum))
  .sort('Alan_Donum', false);

print('📦 Vektör Hazırlandı');

// ========== CHUNK-BASED EXPORT (Timeout Çözümü) ========== 
var totalFeatures = celtikVector.size().getInfo();
print('📊 Toplam Tarla Sayısı:', totalFeatures);

// Chunk'lara bölerek export et
function exportChunk(chunkIndex) {
  var startIdx = chunkIndex * PARAMS.chunk_size;
  var endIdx = startIdx + PARAMS.chunk_size;
  
  var chunk = celtikVector.filterMetadata('system:index', 'less_than', endIdx)
    .filterMetadata('system:index', 'greater_than_or_equal', startIdx);
  
  Export.table.toDrive({
    collection: chunk,
    description: 'Celtik_ML_Alacam_v12_Chunk_' + chunkIndex,
    fileFormat: 'KML'
  });
}

// Tüm chunk'ları export et
var numChunks = Math.ceil(totalFeatures / PARAMS.chunk_size);
for (var i = 0; i < numChunks; i++) {
  exportChunk(i);
}

print('✅ Export başlatıldı (' + numChunks + ' chunk); // ========== ÖZET ========== 
print('');
print('╔════════════════════════════════════╗');
print('║  ÇELTIK ML TESPİTİ v2 - ÖZET      ║');
print('╠════════════════════════════════════╣');
print('║ Toplam Alan: ' + toplamAlanDonum.getInfo().toFixed(2) + ' dönüm');
print('║ Tarla Sayısı: ' + totalFeatures);
print('║ Minumum Alan: ' + PARAMS.min_alan_donum + ' dönüm');
print('║ Eğim Eşiği: ' + PARAMS.slope_threshold + '°');
print('║ RF Ağaçlar: ' + PARAMS.rf_num_trees);
print('╚════════════════════════════════════╝');
print('');
print('✅ TÜM İŞLEMLER TAMAMLANDI!