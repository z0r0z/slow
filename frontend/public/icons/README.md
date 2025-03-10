# Snail Icons

These are PNG icons generated from the snail 🐌 emoji in various sizes for use in the application.

## Available Sizes

- 16x16 pixels: `snail-16.png`
- 32x32 pixels: `snail-32.png`
- 64x64 pixels: `snail-64.png`
- 128x128 pixels: `snail-128.png`
- 256x256 pixels: `snail-256.png`

## Usage in JavaScript

You can import the icons using the provided index.js:

```javascript
import snailIcons from '/public/icons';

// Use specific size
const favicon = snailIcons[16]; // '/icons/snail-16.png'
const largeIcon = snailIcons[256]; // '/icons/snail-256.png'

// Example usage in HTML
document.getElementById('icon').src = snailIcons[64];
```

## Regenerating Icons

If you need to regenerate these icons, run:

```bash
npm run generate-icons
```

This will create new PNG files from the snail emoji.