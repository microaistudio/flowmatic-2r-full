// Test script for settings endpoints
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const baseUrl = 'http://localhost:5050';

// Test 1: GET all settings
async function testGetSettings() {
  console.log('\n=== Testing GET /api/admin/settings ===');
  
  try {
    const response = await fetch(`${baseUrl}/api/admin/settings`);
    const data = await response.json();
    
    console.log(`Found ${data.settings.length} settings`);
    console.log('\nSample settings:');
    data.settings.slice(0, 3).forEach(s => {
      console.log(`- ${s.key}: ${s.value} (${s.category})`);
    });
    
    // Test category filter
    const featuresResponse = await fetch(`${baseUrl}/api/admin/settings?category=features`);
    const featuresData = await featuresResponse.json();
    console.log(`\nFeature flags: ${featuresData.settings.length} settings`);
    
  } catch (error) {
    console.error('GET test failed:', error.message);
  }
}

// Test 2: PUT update settings
async function testUpdateSettings() {
  console.log('\n=== Testing PUT /api/admin/settings ===');
  
  const updates = [
    { key: 'system.name', value: 'FlowMatic-SOLO R2 Test' },
    { key: 'feature.voice_announcements', value: 'false' }
  ];
  
  try {
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates })
    });
    
    const data = await response.json();
    console.log('Update result:', data);
    
    // Verify the update
    const verifyResponse = await fetch(`${baseUrl}/api/admin/settings`);
    const verifyData = await verifyResponse.json();
    
    const updatedSettings = verifyData.settings.filter(s => 
      s.key === 'system.name' || s.key === 'feature.voice_announcements'
    );
    
    console.log('\nUpdated settings:');
    updatedSettings.forEach(s => {
      console.log(`- ${s.key}: ${s.value}`);
    });
    
  } catch (error) {
    console.error('PUT test failed:', error.message);
  }
}

// Run tests
async function runTests() {
  console.log('Testing Settings Management Endpoints...');
  console.log('Make sure server is running on port 5050');
  
  await testGetSettings();
  await testUpdateSettings();
  
  console.log('\n=== Settings tests complete ===');
}

runTests();