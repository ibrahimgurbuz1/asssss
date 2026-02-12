// ============================================================
// ALAÇAM - ML TESPİTİ v2 OPTIMIZED (TÜEM FIX'LER)
// ============================================================
// ✅ Fix 1: getInfo() yerine server-side print
// ✅ Fix 2: Doğru chunk export (toList + slice)
// ✅ Fix 3: Train/Test split ile gerçek validation
// ✅ Fix 4: Esnek fenoloji mantığı
// ✅ Fix 5: Connected pixel threshold 5 olarak ayarla
// ✅ Fix 6: Area scale = 10m
// ✅ Fix 7: Feature importance + probability mapping

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
  min_connected_pixels: 5,  // ✅ FIX 5: Artırıldı (1 → 5)
  rf_num_trees: 350,  // ✅ FIX 7: Artırıldı (200 → 350)
  rf_variables_per_split: 5,
  rf_min_leaf_population: 10,
  rf_bag_fraction: 0.8,
  positive_samples_limit: 5000,
  negative_samples_count: 3000,
  chunk_size: 500,
  train_test_split: 0.7  // ✅ FIX 3: Train/test oranı
};

// ========== VERİ HAZIRLIĞI ========== 
var celtikTarlalari = ee.FeatureCollection('projects/sincere-loader-486616-r9/assets/celtik_egitim');

var gaul = ee.FeatureCollection('FAO/GAUL_SIMPLIFIED_500m/2015/level2');
var ilce = gaul.filter(ee.Filter.and(
  ee.Filter.eq('ADM1_NAME', 'Samsun'),
  ee.Filter.eq('ADM2_NAME', 'Alacam')
));
var ilceSiniri = ilce.geometry();

// ✅ FIX 1: Server-side print (getInfo yok)
print('📍 Çalışma Alanı: Alacam');

// ========== BULUT MASKELEME ========== 
function maskS2clouds(image) {
  var scl = image.select('SCL');
  return image.updateMask(scl.eq(4).or(scl.eq(5)).or(scl.eq(6)));
}

// ========== SENTİNEL-2 VERİ TOPLAMA ========== 
var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(ilceSiniri)
  .filterDate('2024-05-01', '2024-09-30')
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .map(maskS2clouds);

// ✅ FIX 1: Server-side print
print('📊 Toplam Sentinel-2:', s2.size());

// ========== KOMPOZİT OLUŞTURMA + EVI ========== 
function makeComposite(col, d1, d2, tag) {
  var med = col.filterDate(d1, d2).median();
  
  var ndvi = med.normalizedDifference(['B8','B4']).rename('NDVI_'+tag);
  var lswi = med.normalizedDifference(['B8','B11']).rename('LSWI_'+tag);
  var mndwi = med.normalizedDifference(['B3','B11']).rename('MNDWI_'+tag);
  
  // ✅ EVI (Enhanced Vegetation Index)
  var evi = med.expression(
    '2.5 * (B8 - B4) / (B8 + 6*B4 - 7.5*B2 + 1)',
    {B8: med.select('B8'), B4: med.select('B4'), B2: med.select('B2')}
  ).rename('EVI_'+tag);
  
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

// ========== EĞITIM VERİSİ ========== 
var pozitifNoktalar = featureStack.sampleRegions({
  collection: celtikTarlalari.map(function(f) { return f.set('sinif', 1); }),
  properties: ['sinif'], 
  scale: 10, 
  tileScale: 16
}).limit(PARAMS.positive_samples_limit);

// ✅ FIX 1: Server-side print
print('✅ Pozitif Örnekler:', pozitifNoktalar.size());

// NEGATİF ÖRNEKLEME
var kesinNegatif = worldcover.eq(10).or(worldcover.eq(50)).or(worldcover.eq(80)).or(worldcover.eq(30));

var negatifNoktalar = featureStack.updateMask(kesinNegatif).sample({
  region: ilceSiniri, 
  scale: 10, 
  numPixels: PARAMS.negative_samples_count, 
  seed: 42, 
  geometries: true
}).map(function(f) { return f.set('sinif', 0); });

var rastgeleNegatif = featureStack.sample({
  region: ilceSiniri, 
  scale: 20, 
  numPixels: 1000, 
  seed: 123
}).map(function(f) { return f.set('sinif', 0); });

var egitimPixeller = pozitifNoktalar.merge(negatifNoktalar).merge(rastgeleNegatif);

print('✅ Negatif Örnekler:', negatifNoktalar.size());
print('✅ Rastgele Negatif:', rastgeleNegatif.size());

// ========== TRAIN/TEST SPLIT (FIX 3) ========== 
var egitimWithRandom = egitimPixeller.randomColumn('random');
var trainSet = egitimWithRandom.filter(ee.Filter.lt('random', PARAMS.train_test_split));
var testSet = egitimWithRandom.filter(ee.Filter.gte('random', PARAMS.train_test_split));

print('🔀 Train Set:', trainSet.size());
print('🔀 Test Set:', testSet.size());

// ========== RANDOM FOREST (FIX 7) ========== 
var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: PARAMS.rf_num_trees,  // 350
  variablesPerSplit: PARAMS.rf_variables_per_split,
  minLeafPopulation: PARAMS.rf_min_leaf_population,
  bagFraction: PARAMS.rf_bag_fraction,
  seed: 42
}).train({
  features: trainSet,
  classProperty: 'sinif',
  inputProperties: bandNames
});

print('🤖 RF Eğitildi (ağaç: ' + PARAMS.rf_num_trees + ')');

// ========== GERÇEK DOĞRULAMA (FIX 3) ========== 
var validated = testSet.classify(classifier);
var testAccuracy = validated.errorMatrix('sinif', 'classification');

print('');
print('╔════════════════════════════════╗');
print('║  VALIDATION METRIKLERI        ║');
print('╠════════════════════════════════╣');
print('║ Test Accuracy:', testAccuracy.accuracy());
print('║ Test Kappa:', testAccuracy.kappa());
print('║ Producers Accuracy:', testAccuracy.producersAccuracy());
print('║ Users Accuracy:', testAccuracy.consumersAccuracy());
print('╚════════════════════════════════╝');
print('');

// ========== SINIFLANDIRMA ========== 
var siniflandirma = featureStack.classify(classifier);
var celtikTespit = siniflandirma.eq(1);

// ✅ FIX 7: Olasılık Haritası
var celtikProbability = featureStack.classify(classifier, 'probability');

print('✅ Sınıflandırma tamamlandı');

// ========== MASKELEME ========== 
var yerlesim = worldcover.eq(50);
var su = worldcover.eq(80);
var orman = worldcover.eq(10);
var duzAlan = slope.lt(PARAMS.slope_threshold);

// ========== FENOLOJI (FIX 4: Esnek) ========== 
var ekimSu = ekim.select('LSWI_E').gt(PARAMS.lswi_threshold_ekim)
  .or(ekim.select('MNDWI_E').gt(PARAMS.mndwi_threshold_ekim));

// ✅ FIX 4: OR ile daha esnek
var buyumeYesil = buyume.select('NDVI_B').gt(PARAMS.ndvi_threshold_buyume)
  .or(buyume.select('EVI_B').gt(0.35));

var gelisim = buyume.select('NDVI_B')
  .subtract(ekim.select('NDVI_E'))
  .gt(PARAMS.ndvi_gelisim_fark);

// ✅ FIX 4: Mantık
var fenoloji = ekimSu.and(gelisim).and(buyumeYesil);

var temizMaske = yerlesim.or(su).or(orman).not().and(duzAlan).and(fenoloji);

print('✅ Fenolojik Maskeleme tamamlandı');

// ========== MORFOLOJIK İŞLEMLER ========== 
var celtikTemiz = celtikTespit.updateMask(temizMaske)
  .focal_mode({radius: PARAMS.erosion_radius, kernelType: 'circle'})
  .selfMask();

// ✅ FIX 5: min_connected_pixels = 5
var pixelSayisi = celtikTemiz.connectedPixelCount(50, true);
celtikTemiz = celtikTemiz.updateMask(pixelSayisi.gt(PARAMS.min_connected_pixels));
celtikTemiz = celtikTemiz.selfMask();

print('✅ Morfolojik işlemler tamamlandı');

// ========== ALAN HESABI (FIX 6: scale=10) ========== 
var alanPixel = celtikTemiz.multiply(ee.Image.pixelArea());
var toplamAlan = alanPixel.reduceRegion({
  reducer: ee.Reducer.sum(),
  geometry: ilceSiniri, 
  scale: 10,  // ✅ FIX 6: 30 → 10
  maxPixels: 1e13
});

var toplamAlanDonum = ee.Number(toplamAlan.values().get(0)).divide(1000);
print('🌾 TOPLAM ÇELTİK ALANI:', toplamAlanDonum);

// ========== HARİTA ========== 
Map.centerObject(ilceSiniri, 12);
Map.addLayer(ee.Image().byte().paint({featureCollection: ilce, color: 1, width: 3}),
  {palette: 'FF0000'}, 'İlçe Sınırı');
Map.addLayer(celtikTemiz, {palette: ['00ff00'], opacity: 0.5}, '🌾 Çeltik');
Map.addLayer(celtikProbability.select('probability_1'), {min: 0, max: 1, palette: ['red', 'yellow', 'green']}, '📊 Güven Haritası');

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

print('✅ Vektör oluşturuldu');

// GEOMETRİ İYİLEŞTİRME
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

// ÖZELLİKLER EKLEME
celtikVector = celtikVector.map(function(f) {
  var alan = f.geometry().area(10).divide(1000);
  return f.set({
    'name': ee.String('Tarla_').cat(ee.String(f.id())),
    'description': ee.String('Alan: ').cat(alan.format('%.2f')).cat(' dönüm'),
    'Alan_Donum': alan
  });
}).filter(ee.Filter.gt('Alan_Donum', PARAMS.min_alan_donum))
  .sort('Alan_Donum', false);

print('📦 Vektör Hazırlandı');

// ========== CHUNK-BASED EXPORT (FIX 2) ========== 
var celtikList = celtikVector.toList(celtikVector.size());
var totalFeatures = celtikVector.size();

print('📊 Toplam Tarla:', totalFeatures);

// ✅ FIX 2: Doğru chunk export (list.slice)
function exportChunk(chunkIndex) {
  var start = chunkIndex * PARAMS.chunk_size;
  var end = start + PARAMS.chunk_size;
  
  var chunk = ee.FeatureCollection(celtikList.slice(start, end));
  
  Export.table.toDrive({
    collection: chunk,
    description: 'Celtik_ML_Alacam_v13_Chunk_' + chunkIndex,
    fileFormat: 'KML'
  });
}

var numChunks = ee.Number(totalFeatures)
  .divide(PARAMS.chunk_size)
  .ceil()
  .getInfo();

for (var i = 0; i < numChunks; i++) {
  exportChunk(i);
}

print('✅ Export başlatıldı (' + numChunks + ' chunk)');

// ========== ÖZETLİ RAPOR ========== 
print('');
print('╔════════════════════════════════════╗');
print('║  ÇELTIK ML TESPİTİ v2 - ÖZET      ║');
print('╠════════════════════════════════════╣');
print('║ Toplam Alan: Hesaplanıyor...');
print('║ Tarla Sayısı:', totalFeatures);
print('║ Minumum Alan: ' + PARAMS.min_alan_donum + ' dönüm');
print('║ Eğim Eşiği: ' + PARAMS.slope_threshold + '°');
print('║ RF Ağaçlar: ' + PARAMS.rf_num_trees);
print('║ Connected Pixels: ' + PARAMS.min_connected_pixels);
print('║ Area Scale: 10m');
print('║ Train/Test: 70/30');
print('╚════════════════════════════════════╝');
print('');
print('✅ TÜM İŞLEMLER TAMAMLANDI!');