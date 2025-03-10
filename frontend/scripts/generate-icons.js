const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// Sizes for the icons (in pixels)
const sizes = [16, 32, 64, 128, 256];

// Ensure the icons directory exists
const iconsDir = path.join(__dirname, '../public/icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Function to generate a PNG icon of an ouroboros
function generateIcon(size) {
  // Create a canvas with the desired size
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Clear background with transparency
  ctx.clearRect(0, 0, size, size);
  
  // Define colors
  const outerColor = '#3A5A40';     // Dark green for outer body
  const innerColor = '#588157';     // Medium green for inner body
  const eyeColor = 'black';         // Black for eye
  
  // Scaling based on size
  const padding = size * 0.1;  // Padding to keep icon within bounds
  const centerX = size / 2;
  const centerY = size / 2;
  
  // Calculate the circle radius for the ouroboros
  const outerRadius = (size / 2) - padding;
  const innerRadius = outerRadius * 0.6;
  const bodyThickness = outerRadius - innerRadius;
  
  // Draw the main circle of the ouroboros
  ctx.strokeStyle = outerColor;
  ctx.lineWidth = bodyThickness;
  ctx.beginPath();
  ctx.arc(centerX, centerY, (outerRadius + innerRadius) / 2, 0, Math.PI * 1.8);
  ctx.stroke();
  
  // Calculate the head/tail position
  const angle = Math.PI * 1.8; // Where the circle ends
  const headX = centerX + Math.cos(angle) * ((outerRadius + innerRadius) / 2);
  const headY = centerY + Math.sin(angle) * ((outerRadius + innerRadius) / 2);
  
  // Calculate tail position (slightly before the end of the circle)
  const tailAngle = Math.PI * 0.1; // Where the tail starts
  const tailX = centerX + Math.cos(tailAngle) * ((outerRadius + innerRadius) / 2);
  const tailY = centerY + Math.sin(tailAngle) * ((outerRadius + innerRadius) / 2);
  
  // Draw head - a slightly elongated circle
  const headSize = bodyThickness * 1.2;
  ctx.fillStyle = outerColor;
  ctx.beginPath();
  ctx.ellipse(
    headX, 
    headY, 
    headSize, 
    headSize * 0.8, 
    angle, 
    0, 
    Math.PI * 2
  );
  ctx.fill();
  
  // Draw eye
  const eyeSize = headSize * 0.25;
  const eyeAngle = angle + Math.PI * 0.25; // Slightly rotated from head angle
  const eyeDistance = headSize * 0.4;
  const eyeX = headX + Math.cos(eyeAngle) * eyeDistance;
  const eyeY = headY + Math.sin(eyeAngle) * eyeDistance;
  
  ctx.fillStyle = eyeColor;
  ctx.beginPath();
  ctx.arc(eyeX, eyeY, eyeSize, 0, Math.PI * 2);
  ctx.fill();
  
  // Add a highlight to create depth
  ctx.strokeStyle = innerColor;
  ctx.lineWidth = bodyThickness * 0.5;
  ctx.beginPath();
  ctx.arc(centerX, centerY, (outerRadius + innerRadius) / 2, Math.PI * 0.2, Math.PI * 1.7);
  ctx.stroke();
  
  // Draw tail end being eaten
  const tailWidth = bodyThickness * 0.7;
  const tailLength = bodyThickness * 2;
  
  // Calculate position for the tail to appear to enter the mouth
  const mouthAngle = angle - Math.PI * 0.1;
  const mouthX = headX + Math.cos(mouthAngle) * headSize * 0.8;
  const mouthY = headY + Math.sin(mouthAngle) * headSize * 0.8;
  
  // Draw tail
  ctx.fillStyle = innerColor;
  ctx.beginPath();
  ctx.moveTo(mouthX, mouthY);
  // Draw a tapered shape for the tail
  ctx.lineTo(
    mouthX + Math.cos(angle + Math.PI) * tailLength,
    mouthY + Math.sin(angle + Math.PI) * tailLength
  );
  ctx.lineTo(
    mouthX + Math.cos(angle + Math.PI) * tailLength + Math.cos(angle + Math.PI/2) * tailWidth/2,
    mouthY + Math.sin(angle + Math.PI) * tailLength + Math.sin(angle + Math.PI/2) * tailWidth/2
  );
  ctx.lineTo(
    mouthX + Math.cos(angle - Math.PI/2) * tailWidth/2,
    mouthY + Math.sin(angle - Math.PI/2) * tailWidth/2
  );
  ctx.closePath();
  ctx.fill();
  
  // Save the canvas as a PNG file
  const outputPath = path.join(iconsDir, `ouroboros-${size}.png`);
  const out = fs.createWriteStream(outputPath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  
  return new Promise((resolve, reject) => {
    out.on('finish', () => {
      console.log(`Icon created: ${outputPath}`);
      resolve();
    });
    out.on('error', reject);
  });
}

// Generate all icon sizes
async function generateAllIcons() {
  try {
    for (const size of sizes) {
      await generateIcon(size);
    }
    console.log('All icons generated successfully!');
  } catch (error) {
    console.error('Error generating icons:', error);
  }
}

generateAllIcons();