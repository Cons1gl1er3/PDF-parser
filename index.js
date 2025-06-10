// index.js (Final version using direct command-line execution)
require('dotenv').config();
const ILovePDFApi = require('@ilovepdf/ilovepdf-nodejs');
const ILovePDFFile = require('@ilovepdf/ilovepdf-nodejs/ILovePDFFile');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const express = require('express');

// Import Node.js standard utilities for running commands
const util = require('util');
const { execFile } = require('child_process');
const execFileAsync = util.promisify(execFile);


// --- Configuration ---
const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const iLovePdfInstance = new ILovePDFApi(process.env.ILOVEPDF_PUBLIC_KEY, process.env.ILOVEPDF_SECRET_KEY);

const SOURCE_PDF = 'Student Book.pdf';

// --- Core Logic in an async function ---
async function processPdfAndExtractText(splitRange) {
    if (!splitRange) {
        throw new Error('Split range is required.');
    }

    const task = iLovePdfInstance.newTask('split');
    await task.start();

    const file = new ILovePDFFile(path.resolve(SOURCE_PDF));
    await task.addFile(file);
    await task.process({ ranges: splitRange });

    const data = await task.download();
    
    const tempDir = fs.mkdtempSync('pdf-process-');
    const tempPdfPath = path.join(tempDir, 'splitted.pdf');
    fs.writeFileSync(tempPdfPath, data);

    console.log(`PDF split for range "${splitRange}" completed.`);

    // =======================================================================
    // --- PDF to Image Conversion using direct command-line execution ---
    // This method is the most reliable. It calls the `pdftocairo` tool
    // that we install on Railway via nixpacks.toml.
    // =======================================================================
    const outputPrefix = path.join(tempDir, 'page');
    
    const commandArgs = [
        '-jpeg',        // Set the output format to JPEG
        '-r', '150',    // Set the resolution (DPI) to 150
        tempPdfPath,    // The input file
        outputPrefix    // The prefix for the output files (e.g., page-1.jpg)
    ];

    try {
        await execFileAsync('pdftocairo', commandArgs);
    } catch (error) {
        console.error("Error executing pdftocairo. Is Poppler installed and in your PATH?");
        throw error; // Re-throw the error to be caught by the main handler
    }
    // =======================================================================


    console.log('PDF converted to images.');

    const imageFiles = fs.readdirSync(tempDir)
        .filter(f => f.startsWith('page-') && f.endsWith('.jpg'))
        .sort();

    let allExtractedText = '';

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

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('Text extraction complete. Cleanup finished.');

    return allExtractedText;
}

// --- API Endpoint (No changes here) ---
app.get('/extract', async (req, res) => {
    const { ranges } = req.query;

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