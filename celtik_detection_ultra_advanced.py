import cv2
import numpy as np
import matplotlib.pyplot as plt

# Function to perform watershed segmentation

def watershed_segmentation(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Noise removal
    kernel = np.ones((3,3),np.uint8)
    opening = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=2)
    sure_bg = cv2.dilate(opening, kernel, iterations=3)
    dist_transform = cv2.distanceTransform(opening, cv2.DIST_L2, 5)
    _, sure_fg = cv2.threshold(dist_transform, 0.7*dist_transform.max(), 255, 0)
    sure_fg = np.uint8(sure_fg)
    unknown = cv2.subtract(sure_bg, sure_fg)
    # Marker labelling
    _, markers = cv2.connectedComponents(sure_fg)
    markers = markers + 1  # All markers are 1, so we add one
    markers[unknown == 255] = 0  # Label unknown with 0
    # Applying Watershed
    image[unknown == 255] = [255, 0, 0]
    markers = cv2.watershed(image, markers)
    image[markers == -1] = [0, 0, 255]
    return image

# Function to apply multi-scale morphology

def multi_scale_morphology(image):
    scales = [1, 2, 3]
    output = []
    for scale in scales:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*scale + 1, 2*scale + 1))
        morph = cv2.morphologyEx(image, cv2.MORPH_CLOSE, kernel)
        output.append(morph)
    return output

# Function to validate the segmentation results

def validate_segmentation(ground_truth, predicted):
    # Metrics to validate the segmentation
    intersection = np.logical_and(ground_truth, predicted)
    return intersection.sum() / np.logical_or(ground_truth, predicted).sum()  # IoU

# Main function
if __name__ == '__main__':
    # Load your image
    image = cv2.imread('rice_field.jpg')
    # Perform watershed segmentation
    segmented_image = watershed_segmentation(image)
    # Multi-scale morphology
    morphed_images = multi_scale_morphology(segmented_image)
    # Perform validation
    ground_truth = cv2.imread('ground_truth.png', 0)  # Load your ground truth
    iou = validate_segmentation(ground_truth, segmented_image)
    print(f'IoU: {iou}')