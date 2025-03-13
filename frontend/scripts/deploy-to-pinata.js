const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const FormData = require('form-data');
// Add duplex option to all axios HTTP requests to resolve Node 20+ issue
axios.defaults.headers.common['connection'] = 'keep-alive';
axios.defaults.httpAgent = new (require('http').Agent)({ keepAlive: true });
axios.defaults.httpsAgent = new (require('https').Agent)({ keepAlive: true });

// For Node.js 20+: Ensure FormData handling works properly
axios.interceptors.request.use((config) => {
  if (config.data instanceof FormData) {
    Object.assign(config, {
      duplex: 'half'
    });
  }
  return config;
});

const { PinataSDK } = require('pinata'); // Updated import

// Load environment variables from .env file
dotenv.config();

// Path to the dist directory
const distPath = path.join(__dirname, '..', 'dist');

// Check authentication methods
let useJwt = false;
let usePinataSDK = false;

if (process.env.PINATA_JWT) {
  useJwt = true;
  console.log('Using Pinata JWT authentication');
} else if (process.env.PINATA_API_KEY && process.env.PINATA_SECRET_API_KEY) {
  usePinataSDK = true;
  console.log('Using Pinata API Key/Secret authentication');
} else {
  console.error('Error: Pinata credentials are required. Set either PINATA_JWT or both PINATA_API_KEY and PINATA_SECRET_API_KEY environment variables.');
  process.exit(1);
}

// Initialize Pinata SDK
const pinata = useJwt 
  ? new PinataSDK({ pinataJwt: process.env.PINATA_JWT }) 
  : new PinataSDK({ 
      pinataJwt: `${process.env.PINATA_API_KEY}:${process.env.PINATA_SECRET_API_KEY}` 
    });

// Function to recursively read directory and create a map of file paths
async function buildFileList(dir, rootDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);
    
    if (entry.isDirectory()) {
      const subFiles = await buildFileList(fullPath, rootDir);
      files.push(...subFiles);
    } else {
      files.push({
        path: relativePath,
        content: fs.readFileSync(fullPath)
      });
    }
  }

  return files;
}

// Function to upload a file to Pinata using JWT
async function uploadFileV3(file, jwt, retries = 3) {
  const formData = new FormData();
  
  // In Node.js environment, append buffer directly with filename metadata
  // No need for Blob or File objects which are browser APIs
  formData.append('file', file.content, {
    filename: file.path,
    contentType: getContentType(file.path)
  });
  
  // Set to public network
  formData.append('network', 'public');
  
  try {
    const response = await axios.post('https://uploads.pinata.cloud/v3/files', formData, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': `multipart/form-data; boundary=${formData.getBoundary()}`
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    return response.data;
  } catch (error) {
    if (retries > 0 && (
      error.code === 'ECONNRESET' || 
      error.code === 'ETIMEDOUT' || 
      (error.response && error.response.status >= 500)
    )) {
      console.log(`Retrying upload for ${file.path}... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Add delay before retry
      return await uploadFileV3(file, jwt, retries - 1);
    }
    
    console.error(`Error uploading ${file.path}:`, error.message);
    throw error;
  }
}

// Helper function to determine content type based on file extension
function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.js': return 'application/javascript';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

// Function to create a folder structure as a Pinata Group
async function createGroup(name, jwt) {
  try {
    const response = await axios.post('https://api.pinata.cloud/v3/groups/public', {
      name,
      is_public: true
    }, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      }
    });
    
    return response.data.data.id;
  } catch (error) {
    console.error('Error creating group:', error.message);
    throw error;
  }
}

// Function to deploy the directory to Pinata using SDK
async function deployWithPinataSDK() {
  try {
    // Verify the dist directory exists
    if (!fs.existsSync(distPath)) {
      console.error('Error: dist directory does not exist. Run "npm run build" first.');
      process.exit(1);
    }

    console.log('Uploading to Pinata using SDK...');
    
    // Build file list
    console.log('Building file list...');
    const files = await buildFileList(distPath, distPath);
    console.log(`Found ${files.length} files to upload`);
    
    // Create a group for this deployment
    const deploymentName = `SLOW Frontend - ${new Date().toISOString()}`;
    console.log(`Creating group: ${deploymentName}`);
    const groupResponse = await pinata.groups.public.create({
      name: deploymentName,
      isPublic: true
    });
    const groupId = groupResponse.id;
    console.log(`Group created with ID: ${groupId}`);
    
    // Upload each file
    console.log('Uploading files...');
    const uploadedFiles = [];
    let indexFileCid = null;
    
    for (const file of files) {
      console.log(`Uploading ${file.path}...`);
      
      // For Node.js, we'll use the buffer directly
      // No need for browser-specific Blob and File objects
      
      // Upload the file
      try {
        const result = await pinata.upload.public.buffer(file.content, {
            fileName: path.basename(file.path),
            contentType: getContentType(file.path)
          })
          .name(file.path)
          .keyvalues({
            deployment: deploymentName,
            path: file.path
          })
          .group(groupId);
        
        uploadedFiles.push({
          path: file.path,
          cid: result.cid,
          id: result.id
        });
        
        // Track the CID of index.html for gateway URL
        if (file.path === 'index.html') {
          indexFileCid = result.cid;
        }
      } catch (error) {
        console.error(`Error uploading ${file.path}:`, error.message);
        // Continue with other files
      }
    }
    
    console.log('Upload successful!');
    if (indexFileCid) {
      console.log(`View your site at: https://gateway.pinata.cloud/ipfs/${indexFileCid}`);
      console.log(`Or at: https://${indexFileCid}.ipfs.dweb.link/`);
    } else {
      console.log('Warning: index.html not found in uploads');
    }
    
    console.log(`All files have been added to group: ${deploymentName} (${groupId})`);
    return uploadedFiles;
  } catch (error) {
    console.error('Error deploying to Pinata:', error);
    process.exit(1);
  }
}

// Function to deploy the directory to Pinata using V3 API with JWT
async function deployWithPinataV3() {
  try {
    // Verify the dist directory exists
    if (!fs.existsSync(distPath)) {
      console.error('Error: dist directory does not exist. Run "npm run build" first.');
      process.exit(1);
    }

    const jwt = process.env.PINATA_JWT;
    console.log('Uploading to Pinata using V3 API...');
    
    // Create a group for this deployment
    const deploymentName = `SLOW Frontend - ${new Date().toISOString()}`;
    console.log(`Creating group: ${deploymentName}`);
    const groupId = await createGroup(deploymentName, jwt);
    console.log(`Group created with ID: ${groupId}`);
    
    // Build file list
    console.log('Building file list...');
    const files = await buildFileList(distPath, distPath);
    console.log(`Found ${files.length} files to upload`);
    
    // Upload each file with proper directory structure
    console.log('Uploading files...');
    const uploadedFiles = [];
    let indexFileCid = null;
    
    for (const file of files) {
      console.log(`Uploading ${file.path}...`);
      const result = await uploadFileV3(file, jwt);
      uploadedFiles.push({
        path: file.path,
        cid: result.data.cid,
        id: result.data.id
      });
      
      // Track the CID of index.html for gateway URL
      if (file.path === 'index.html') {
        indexFileCid = result.data.cid;
      }
      
      // Add file to the group - fixed the endpoint
      await axios.put(`https://api.pinata.cloud/v3/groups/public/${groupId}/ids/${result.data.id}`, {}, {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        }
      });
    }
    
    console.log('Upload successful!');
    if (indexFileCid) {
      console.log(`View your site at: https://gateway.pinata.cloud/ipfs/${indexFileCid}`);
      console.log(`Or at: https://${indexFileCid}.ipfs.dweb.link/`);
    } else {
      console.log('Warning: index.html not found in uploads');
    }
    
    console.log(`All files have been added to group: ${deploymentName} (${groupId})`);
    return uploadedFiles;
  } catch (error) {
    console.error('Error deploying to Pinata:', error);
    process.exit(1);
  }
}

// Execute the deploy function based on available credentials
async function deployToPinata() {
  try {
    // Test authentication first
    await pinata.testAuthentication();
    console.log('Authentication successful!');
    
    if (useJwt) {
      return deployWithPinataV3();
    } else if (usePinataSDK) {
      return deployWithPinataSDK();
    }
  } catch (error) {
    console.error('Authentication failed:', error.message);
    process.exit(1);
  }
}

// Execute the deploy function
deployToPinata();