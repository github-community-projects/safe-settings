#!/usr/bin/env node

/**
 * Tech Asset Configuration Enrichment Script
 * 
 * This script processes all repo YAML files in .github/repos/ and enriches
 * them with additional tech asset metadata from an external service.
 * 
 * Usage: node enrich-tech-assets.js
 * 
 * Environment variables:
 * - TECH_ASSET_SERVICE_URL: URL of your tech asset service
 * - TECH_ASSET_SERVICE_TOKEN: Authentication token
 */

const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

const SERVICE_URL = process.env.TECH_ASSET_SERVICE_URL;
const SERVICE_TOKEN = process.env.TECH_ASSET_SERVICE_TOKEN;
const REPOS_DIR = path.join(process.cwd(), '.github/repos');

// Import fetch - works in Node 18+
const fetch = globalThis.fetch || require('node-fetch');

/**
 * Fetch tech asset data from external service
 */
async function fetchTechAssetData(uuid) {
  try {
    const response = await fetch(`${SERVICE_URL}/assets/${uuid}`, {
      headers: {
        'Authorization': `Bearer ${SERVICE_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ Failed to fetch tech asset data for UUID ${uuid}: ${error.message}`);
    throw error;
  }
}

/**
 * Process a single repo YAML file
 */
async function processRepoFile(filePath) {
  console.log(`\n📄 Processing: ${path.basename(filePath)}`);
  
  try {
    // Read and parse YAML
    const content = await fs.readFile(filePath, 'utf8');
    const config = yaml.load(content);

    // Check if this file needs enrichment
    if (!config.custom_properties || !Array.isArray(config.custom_properties)) {
      console.log('  ℹ️  No custom_properties found, skipping');
      return { processed: false };
    }

    // Find tech-asset-uuid
    const techAssetProp = config.custom_properties.find(
      prop => prop.name === 'tech-asset-uuid' || prop.property_name === 'tech-asset-uuid'
    );

    if (!techAssetProp) {
      console.log('  ℹ️  No tech-asset-uuid found, skipping');
      return { processed: false };
    }

    const uuid = techAssetProp.value;
    console.log(`  🔍 Found tech-asset-uuid: ${uuid}`);

    // Fetch enrichment data
    console.log('  🌐 Fetching metadata from service...');
    const assetData = await fetchTechAssetData(uuid);
    console.log(`  ✅ Received metadata: ${JSON.stringify(assetData, null, 2)}`);

    // Remove existing tech-asset-* properties (except uuid)
    config.custom_properties = config.custom_properties.filter(
      prop => !prop.name.startsWith('tech-asset-') || prop.name === 'tech-asset-uuid'
    );

    // Add enriched properties
    const enrichedProps = [
      { name: 'tech-asset-tag', value: assetData.tag },
      { name: 'tech-asset-id', value: assetData.id },
      { name: 'tech-asset-owner', value: assetData.owner }
    ];

    // Add optional fields if present
    if (assetData.cost_center) {
      enrichedProps.push({ name: 'tech-asset-cost-center', value: assetData.cost_center });
    }
    if (assetData.classification) {
      enrichedProps.push({ name: 'tech-asset-classification', value: assetData.classification });
    }

    // Append new properties
    config.custom_properties.push(...enrichedProps);

    // Add a comment in the YAML about auto-generation
    const enrichmentComment = 
      '# Tech asset properties below are auto-generated from tech-asset-uuid\n' +
      '# DO NOT EDIT MANUALLY - they will be overwritten\n';

    // Write back to file
    const updatedYaml = yaml.dump(config, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false
    });

    // Find the custom_properties section and add comment
    const lines = updatedYaml.split('\n');
    const customPropsIndex = lines.findIndex(line => line.trim() === 'custom_properties:');
    
    if (customPropsIndex !== -1) {
      // Find where tech-asset-tag starts (first enriched property)
      const techAssetTagIndex = lines.findIndex(
        (line, idx) => idx > customPropsIndex && line.includes('tech-asset-tag')
      );
      
      if (techAssetTagIndex !== -1) {
        lines.splice(techAssetTagIndex, 0, enrichmentComment);
      }
    }

    await fs.writeFile(filePath, lines.join('\n'), 'utf8');
    
    console.log(`  ✨ Enriched with ${enrichedProps.length} properties`);
    
    return {
      processed: true,
      uuid,
      enrichedProperties: enrichedProps.map(p => p.name)
    };

  } catch (error) {
    console.error(`  ❌ Error processing file: ${error.message}`);
    return { processed: false, error: error.message };
  }
}

/**
 * Process all repo YAML files
 */
async function processAllRepos() {
  console.log('🚀 Starting tech asset enrichment...\n');
  
  // Validate environment variables
  if (!SERVICE_URL || !SERVICE_TOKEN) {
    console.error('❌ Missing required environment variables:');
    if (!SERVICE_URL) console.error('  - TECH_ASSET_SERVICE_URL');
    if (!SERVICE_TOKEN) console.error('  - TECH_ASSET_SERVICE_TOKEN');
    process.exit(1);
  }

  console.log(`📍 Service URL: ${SERVICE_URL}`);
  console.log(`📁 Repos directory: ${REPOS_DIR}\n`);

  try {
    // Read all files in repos directory
    const files = await fs.readdir(REPOS_DIR);
    const yamlFiles = files.filter(
      f => f.endsWith('.yml') || f.endsWith('.yaml')
    );

    console.log(`📦 Found ${yamlFiles.length} YAML files\n`);

    if (yamlFiles.length === 0) {
      console.log('ℹ️  No YAML files to process');
      return;
    }

    // Process each file
    const results = [];
    for (const file of yamlFiles) {
      const filePath = path.join(REPOS_DIR, file);
      const result = await processRepoFile(filePath);
      results.push({ file, ...result });
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 ENRICHMENT SUMMARY');
    console.log('='.repeat(60));

    const processed = results.filter(r => r.processed);
    const skipped = results.filter(r => !r.processed && !r.error);
    const errors = results.filter(r => r.error);

    console.log(`\n✅ Processed: ${processed.length} files`);
    processed.forEach(r => {
      console.log(`   - ${r.file}: ${r.enrichedProperties.join(', ')}`);
    });

    if (skipped.length > 0) {
      console.log(`\nℹ️  Skipped: ${skipped.length} files`);
      skipped.forEach(r => {
        console.log(`   - ${r.file}`);
      });
    }

    if (errors.length > 0) {
      console.log(`\n❌ Errors: ${errors.length} files`);
      errors.forEach(r => {
        console.log(`   - ${r.file}: ${r.error}`);
      });
    }

    // Write log for GitHub Actions
    const logContent = results
      .filter(r => r.processed)
      .map(r => `- **${r.file}**: Enriched with \`${r.enrichedProperties.join('`, `')}\``)
      .join('\n');

    if (logContent) {
      await fs.writeFile('.tech-asset-enrichment.log', logContent, 'utf8');
      console.log('\n📝 Log written to .tech-asset-enrichment.log');
    }

    console.log('\n✨ Enrichment complete!\n');

    // Exit with error code if any files had errors
    if (errors.length > 0) {
      process.exit(1);
    }

  } catch (error) {
    console.error(`\n❌ Fatal error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  processAllRepos();
}

module.exports = { processAllRepos, processRepoFile, fetchTechAssetData };
