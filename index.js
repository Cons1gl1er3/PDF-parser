// index.js
require('dotenv').config(); // Use for local development with a .env file
const ILovePDFApi = require('@ilovepdf/ilovepdf-nodejs');
const ILovePDFFile = require('@ilovepdf/ilovepdf-nodejs/ILovePDFFile');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const pdf = require('pdf-poppler');
const express = require('express');

// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000; // Railway provides the PORT environment variable

// Initialize OpenAI and iLovePDF with environment variables
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const instance = new ILovePDFApi(process.env.ILOVEPDF_PUBLIC_KEY, process.env.ILOVEPDF_SECRET_KEY);

const SOURCE_PDF = 'Student Book.pdf';

// --- Core Logic in an async function ---
async function processPdfAndExtractText(splitRange) {
    if (!splitRange) {
        throw new Error('Split range is required.');
    }

    const task = instance.newTask('split');
    await task.start();

    const file = new ILovePDFFile(path.resolve(SOURCE_PDF));
    await task.addFile(file);
    await task.process({ ranges: splitRange });

    const data = await task.download();
    
    // Use a temporary directory for processing
    const tempDir = fs.mkdtempSync('pdf-process-');
    const tempPdfPath = path.join(tempDir, 'splitted.pdf');
    fs.writeFileSync(tempPdfPath, data);

    console.log(`PDF split for range "${splitRange}" completed.`);

    // Convert PDF to images
    const opts = {
        format: 'jpeg',
        out_dir: tempDir,
        out_prefix: 'page',
        page: null,
    };
    await pdf.convert(tempPdfPath, opts);
    console.log('PDF converted to images.');

    const imageFiles = fs.readdirSync(tempDir)
        .filter(f => f.startsWith('page-') && f.endsWith('.jpg'))
        .sort();

    let allExtractedText = '';

    // Process each image with OpenAI
    for (const imageFile of imageFiles) {
        const imagePath = path.join(tempDir, imageFile);
        const base64Image = fs.readFileSync(imagePath).toString('base64');

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "user",
                content: [{
                    type: "text",
                    text: "Extract all text from this image. Preserve the formatting and structure as much as possible."
                }, {
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                }]
            }],
            max_tokens: 4096,
        });
        allExtractedText += `\n--- Page ${imageFile.replace('.jpg', '')} ---\n${response.choices[0].message.content}\n`;
    }

    // Clean up temporary files and directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('Text extraction complete. Cleanup finished.');

    return allExtractedText;
}

// --- API Endpoint ---
app.get('/extract', async (req, res) => {
    const { ranges } = req.query; // e.g., /extract?ranges=2-8

    if (!ranges) {
        return res.status(400).json({ error: 'Please provide page ranges using the "ranges" query parameter.' });
    }

    console.log(`Received request for ranges: ${ranges}`);

    try {
        const extractedText = await processPdfAndExtractText(ranges);
        res.set('Content-Type', 'text/plain');
        res.send(extractedText);
    } catch (error) {
        console.error('An error occurred during the process:', error);
        res.status(500).json({ error: 'Failed to process PDF.', details: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running and listening on port ${PORT}`);
});