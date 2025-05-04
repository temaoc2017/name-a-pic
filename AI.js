import path from "path";
import fs from "fs";
import https from "https";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function httpsRequest(params, postData) {
  return new Promise(function(resolve, reject) {
    let req = https.request(params, function(res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error('statusCode=' + res.statusCode));
      }
      let body = [];
      res.on('data', function(chunk) {
        body.push(chunk);
      });
      res.on('end', function() {
        try {
          body = Buffer.concat(body);
        } catch(e) {
          reject(e);
        }
        resolve(body);
      });
    });
    req.on('error', function(err) {
      reject(err);
    });
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class AI {
  static fileCache = new Map();

  // static chat = ai.chats.create({
  //   model: 'gemini-2.0-flash',
  //   config: {
  //     temperature: 0.6,
  //     candidateCount: 1,
  //     maxOutputTokens: 32,
  //   }
  // });

  // static async makeRequest(...params) {
  //   for (let tries = 0; tries < 10; tries++) {
  //     try {
  //       return await this.chat.sendMessage(...params);
  //     } catch (error) {
  //       await sleep(2000);
  //       if (!(error.name == "ServerError")) { // TODO this probably does not work
  //         throw error;
  //       } else {
  //         console.log(error);
  //       }
  //     }
  //   }
  //   chat = ai.chats.create({
  //     model: 'gemini-2.0-flash',
  //     config: {
  //       temperature: 0.5,
  //       candidateCount: 1,
  //       maxOutputTokens: 32,
  //     }
  //   });
  //   return await this.makeRequest(...params);
  // }

  static async makeRequest(params) {
    let generateContentParams = params;
    generateContentParams.model = 'gemini-2.0-flash';
    if (!generateContentParams.config) {
      generateContentParams.config = {};
    }
    generateContentParams.config.temperature = 0.6;
    generateContentParams.config.maxOutputTokens = 32;
    generateContentParams.contents = generateContentParams.message;
    for (let tries = 0; tries < 10; tries++) {
      try {
        return await ai.models.generateContent(params);
      } catch (error) {
        await sleep(2000);
        if (!(error.name == "ServerError")) { // TODO this probably does not work
          throw error;
        } else {
          console.log(error);
        }
      }
    }
  }

  static async getFile(fileName) {
    if (this.fileCache.get(fileName)) {
      return this.fileCache[fileName];
    }

    let linkPattern = /^https:\/\/cdn/;
    let file;
    if (fileName.match(linkPattern) == null) {
      const filePath = path.join("public/cards", fileName);
      file = { buffer: fs.readFileSync(filePath), name: fileName };
    } else {
      const data = await httpsRequest(fileName);
      file = { buffer: data, name: fileName };
    }
    this.fileCache[fileName] = file;

    return file;
  }

  static async nameCard(cardSrc) {
    const file = await this.getFile(cardSrc);
    const base64File = file.buffer.toString('base64');
    // console.log(base64File);
    const extRegex = /\.(png|jpg|jpeg)$/;
    const ext = file.name.match(extRegex)[1];
    // console.log(ext);
    const chatResponse = await this.makeRequest({
      message: [
        {
          inlineData: {
            mimeType: 'image/' + ext, // Adjust based on your image type
            data: base64File,
          },
        },
        { text: `Write a very general, abstract association for this image. Use a phrase consisting of one or two, maximum three words. Make association very not obvious by NOT using words that would describe objects on the image OR their synonyms. DON'T describe details. You can make the association humorous or emotional, association with the plot of the image. Пиши українською.` },
      ]
    });
  
    let cardName = chatResponse.text.replace(".", "");
    console.log(cardName);
    
    return cardName;
  }

  static async chooseCard(cardSrcs, name) {
    let message = [];

    for (const cardSrc of cardSrcs) {
      const file = await this.getFile(cardSrc);
      const base64File = file.buffer.toString('base64');
      const extRegex = /\.(png|jpg|jpeg)$/;
      const ext = file.name.match(extRegex)[1];
      message.push({
        inlineData: {
          mimeType: 'image/' + ext, // Adjust based on your image type
          data: base64File,
        },
      })
    }

    message.push({ text: `Which of these ${cardSrcs.length} images best suits the name <name>${name}</name>? Answer in just a couple words with an image number. I understand that choosing one image may be tough, but you must choose one. Providing the image number is a must.` })

    const chatResponse = await this.makeRequest({ message });
    // TODO don't forget to subtract one
    const numberRegex = /(\d+)/;

    console.log(chatResponse.text);
    const chosenCard = Number.parseInt(chatResponse.text.match(numberRegex)[1]) - 1;
    console.log(chosenCard);

    return (chosenCard + cardSrcs.length) % cardSrcs.length;
  }
}

AI.nameCard("https://cdn.glitch.global/c2723664-fc3b-43a0-9809-d919707a7e64/355.jpeg");
AI.nameCard("18.png");
AI.chooseCard(["https://cdn.glitch.global/c2723664-fc3b-43a0-9809-d919707a7e64/355.jpeg", "18.png"], "Вічне цвітіння")