import ee
import numpy as np
import cv2
import random
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score
import matplotlib.pyplot as plt
import geopandas as gpd
import pandas as pd

# Initialize Earth Engine
ee.Initialize()

# Function to get Sentinel-2 data
def get_sentinel_data(start_date, end_date, region):
    collection = ee.ImageCollection('COPERNICUS/S2')
    image = collection.filterDate(start_date, end_date)
    image = image.filterBounds(region).median()  # Use median to reduce noise
    return image

# Function to train Random Forest model
def train_random_forest(train_X, train_y):
    model = RandomForestClassifier(n_estimators=150)
    model.fit(train_X, train_y)
    return model

# Function for watershed segmentation
def watershed_segmentation(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dist_transform = cv2.distanceTransform(gray, cv2.DIST_L2, 5)
    _, sure_fg = cv2.threshold(dist_transform, 0.7 * dist_transform.max(), 255, 0)
    contours, _ = cv2.findContours(gray, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return contours

# Function for multi-scale morphology
def multi_scale_morphology(image, kernel_sizes):
    results = []
    for size in kernel_sizes:
        kernel = np.ones((size, size), np.uint8)
        erosion = cv2.erode(image, kernel, iterations=1)
        dilation = cv2.dilate(erosion, kernel, iterations=1)
        results.append(dilation)
    return results

# Function for geometry extraction
def extract_geometry(contours):
    geometries = []
    for c in contours:
        if cv2.contourArea(c) > 100:  # Filter small contours
            x, y, w, h = cv2.boundingRect(c)
            aspect_ratio = float(w) / h
            circularity = (4 * np.pi * cv2.contourArea(c)) / (cv2.arcLength(c, True) ** 2)
            geometries.append({'area': cv2.contourArea(c), 'perimeter': cv2.arcLength(c, True), 'circularity': circularity, 'aspect_ratio': aspect_ratio})
    return geometries

# Function for validation metrics
def validation_metrics(true_labels, predicted_labels):
    accuracy = accuracy_score(true_labels, predicted_labels)
    precision = precision_score(true_labels, predicted_labels)
    recall = recall_score(true_labels, predicted_labels)
    f1 = f1_score(true_labels, predicted_labels)
    return accuracy, precision, recall, f1

# Function for visualization
def visualize_results(image, contours):
    for c in contours:
        cv2.drawContours(image, [c], -1, (0, 255, 0), 2)
    plt.imshow(image)
    plt.axis('off')
    plt.savefig('field_detection_results.png')

# Function for exporting results
def export_results(geometries):
    df = pd.DataFrame(geometries)
    df.to_csv('field_metrics.csv', index=False)
    # Additional KML export can be implemented here

# Main script execution
if __name__ == '__main__':
    start_date = '2021-01-01'
    end_date = '2021-12-31'
    region = ee.Geometry.Rectangle([102.0, -1.0, 104.0, 1.0])  # Example region
    image = get_sentinel_data(start_date, end_date, region)
    
    # Convert to cv2 image (assuming conversion appropriate)
    # Perform segmentation and analysis
    contours = watershed_segmentation(image)
    geometries = extract_geometry(contours)
    
    # Assume we have true and predicted labels for validation
    true_labels = []  # Populate with actual labels
    predicted_labels = []  # Populate with model predictions
    metrics = validation_metrics(true_labels, predicted_labels)
    print('Validation Metrics:', metrics)
    
    # Visualize results
    visualize_results(image, contours)
    
    # Export results
    export_results(geometries)
