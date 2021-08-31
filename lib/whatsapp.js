const { AsyncConstructor } = require("async-constructor");
const venom = require('venom-bot');
const config = require("../config.json");
const tools = require("./tools");
const Axios = require('axios');
const mime = require('mime-types');
const isUrl = require("is-valid-http-url");
const { downloadFile } = require('./downloads');
const { Image } = require("./image");
const { Video } = require("./video");

class Whatsapp extends AsyncConstructor {

    constructor() {
        super(async () => {
            this.client;

            await venom
                .create(
                    'session',
                    (base64Qrimg, asciiQR, attempts, urlCode) => {
                        tools.conlog_info('Number of attempts to read the qrcode: ', attempts);
                        console.log(`Whatsapp Web QRcode:\n${asciiQR}`);
                    },
                    (statusSession, session) => {
                        tools.conlog_info(`Status Session: ${statusSession}`);
                        tools.conlog_info(`Session name: ${session}`);
                    }, {
                        folderNameToken: 'tokens',
                        headless: config.headless,
                        debug: false,
                        devtools: config.debug,
                        disableSpins: config.consoleAnimations,
                        disableWelcome: true,
                        updatesLog: config.debug,
                        autoClose: 60000,
                    }
                )
                .then((client) => {
                    this.client = client;
                    this.start();
                })
                .catch((err) => {
                    tools.conlog_error(err);
                });
        });
    }

    async start() {
        tools.conlog_info_force("Session started");

        this.client.onMessage(async (message) => {
            await new Message_was(this.client, message);
        });

        if (config.onIncomingCall) {
            this.client.onIncomingCall(async (call) => {
                let id = tools.genId();

                if (config.debug) {
                    console.log(call);
                }

                tools.conlog_info_force(`[${id}] Incoming call: ${call.peerJid.split("@")[0]}`);

                this.client.sendText(call.peerJid, _.t("onIncomingCall"));
            });
        }

        process.on('SIGINT', function() {
            tools.conlog_info_force("Close this.client");
            this.client.close();
        });
    }


}

class Message_was extends AsyncConstructor {
    constructor(client, message) {
        super(async () => {
            this.client = client;
            this.id = tools.genId();
            this.message = message;
            this.file;
            this.image;
            this.video;

            if (config.debug) {
                console.log(this.message);
            }

            if (this.message.chatId === "status@broadcast") {
                tools.conlog_info(`[${this.id}] New status detected, for user: ${await this.realNumber(this.message.author)}`);
                return;
            }

            let check;

            if (this.message.isGroupMsg) {
                if (config.workInGroups) {
                    tools.conlog_info_force(`[${this.id}] New group message: ${this.message.chat.contact.formattedName}, for user: ${await this.realNumber(this.message.author)}`);
                } else {
                    tools.conlog_info_force(`[${this.id}] New group message: ${this.message.chat.contact.formattedName}, for user: ${await this.realNumber(this.message.author)} -- rejected by workInGroups: False`);

                    return;
                }
            } else {
                tools.conlog_info_force(`[${this.id}] New user message for: ${await this.realNumber(this.message.from)}`);
            }

            check = await this.checkMessage();

            if (check !== "Command-reject" && check !== "Video-reject" && check !== "Url-Reject" && check !== "Video-Url-Reject" && check !== "Url-No-Detected") {
                await this.client.sendText(this.message.chatId, _.t("Generating"));
            }

            switch (check) {
                case "Image":
                    this.file = await this.downloadFileMessage(true);
                    this.image = new Image(this.id, this.file);
                    await this.image.resize();

                    tools.conlog_info_force(`[${this.id}] Generated sticker file and sending`);
                    await this.sendImage();

                    break;
                case "Gif":
                case "Video":
                    this.file = await this.downloadFileMessage(true);
                    this.video = await new Video(this.id, this.file);

                    await this.video.colorTreated();
                    await this.video.resize("webp");
                    // await this.video.resize("gif");

                    tools.conlog_info_force(`[${this.id}] Generated animated sticker file and sending`);
                    await this.sendVideo(this.video.Webm);

                    break;
                case "Image-Url":
                    this.file = await downloadFile(this.id, this.message.content);
                    this.image = new Image(this.id, this.file);
                    await this.image.resize();

                    tools.conlog_info_force(`[${this.id}] Generated sticker file and sending`);
                    await this.sendImage();

                    break;
                case "Video-Url":
                    this.file = await downloadFile(this.id, this.message.content);
                    this.video = await new Video(this.id, this.file);

                    await this.video.colorTreated();
                    await this.video.resize("webp");
                    // await this.video.resize("gif");

                    tools.conlog_info_force(`[${this.id}] Generated animated sticker file and sending`);

                    await this.sendVideo(this.video.Webm);

                    break;
                case "Image-disable":
                case "Image-Url-disable":
                case "Gif-disable":
                case "Video-disable":
                case "Video-Url-disable":
                    break;
                case "Command-reject":
                case "Video-reject":
                case "Url-Reject":
                case "Video-Url-Reject":
                case "Url-No-Detected":
                    if (!config.notifyUrlNotDetected && (check === "Url-No-Detected" || check === "Command-reject")) {
                        break;
                    }
                    if (config.notifyRejectionStickerGeneration) {
                        await this.client.sendText(this.message.chatId, _.t(check));
                    }
                    break;
            }

            if (config.cleanTemp) {
                tools.conlog_info(`[${this.id}] Deleting temporary files`);
                await tools.cleanFileTemp(this.id);
            }
        });
    }

    async checkMessage() {
        if (this.message.isMedia || this.message.type === "document") {

            if (config.activeCommand) {
                if (!config.customActiveCommand.includes(this.message.caption)) {
                    tools.conlog_info_force(`[${this.id}] rejected by customActiveCommand: No matches found`);
                    return "Command-reject";
                }
            }

            if (this.message.isGif) {
                if (!config.options.GifToSticker) {
                    tools.conlog_info_force(`[${this.id}] Gif detected --- rejected because it is disabled GifToSticker`);

                    return "Gif-disable"
                }
                tools.conlog_info_force(`[${this.id}] Gif detected`);

                return "Gif";
            } else if (this.message.type === "video" || this.message.mimetype.split("/")[0] === "video") {
                if (config.options.VideoToSticker) {
                    if (tools.bytesToMegas(this.message.size) <= config.maxSizeVideo) {
                        tools.conlog_info_force(`[${this.id}] Video detected`);

                        return "Video";
                    } else {
                        tools.conlog_info_force(`[${this.id}] Video detected --- rejected for exceeding maxSizeVideo`);

                        return "Video-reject";
                    }
                } else {
                    tools.conlog_info_force(`[${this.id}] Video detected --- rejected because it is disabled VideoToSticker`);

                    return "Video-disable"
                }
            } else if (this.message.type === "image" || this.message.mimetype.split("/")[0] === "image") {
                if (!config.options.ImgToSticker) {
                    tools.conlog_info_force(`[${this.id}] Image detected --- rejected because it is disabled ImgToSticker`);

                    return "Image-disable"
                }
                tools.conlog_info_force(`[${this.id}] Image detected`);

                return "Image";
            }
        } else if (this.message.type === "chat") {
            let check = isUrl(this.message.content);

            if (check) {
                tools.conlog_info(`[${this.id}] Url detected`);

                const response = await Axios.get(this.message.content)
                    .then(async function(response) {
                        if (config.debug) {
                            console.log(response);
                        }

                        return response;
                    })
                    .catch((err) => {
                        tools.conlog_error(`[${this.id}] ${err.toString()}`);
                    });

                let type = response.headers["content-type"].split("/")[0];

                if (type === "video") {
                    if (config.options.VideoUrlToSticker) {
                        if (tools.bytesToMegas(response.headers["content-length"]) <= config.maxSizeVideo) {
                            tools.conlog_info_force(`[${this.id}] Video Url detected`);

                            return "Video-Url";
                        } else {
                            tools.conlog_info_force(`[${this.id}] Video Url detected --- rejected for exceeding maxSizeVideo`);

                            return "Video-Url-Reject";
                        }
                    } else {
                        tools.conlog_info_force(`[${this.id}] Video Url detected --- rejected because it is disabled VideoUrlToSticker`);

                        return "Video-Url-disable"
                    }
                } else if (type === "image") {
                    if (!config.options.ImgUrlToSticker) {
                        tools.conlog_info_force(`[${this.id}] Image Url detected --- rejected because it is disabled ImgUrlToSticker`);

                        return "Image-Url-disable"
                    }
                    tools.conlog_info_force(`[${this.id}] Image Url detected`);

                    return "Image-Url";
                } else {
                    tools.conlog_info_force(`[${this.id}] Url detected but no multimedia content has been detected`);

                    return "Url-Reject";
                }
            }
            tools.conlog_info_force(`[${this.id}] Url no detected`);

            return "Url-No-Detected";
        }
    }

    async realNumber(number) {
        let result = await this.client.getNumberProfile(number);
        return result.id.user;
    }

    async downloadFileMessage(file) {
        const decryptFile = await this.client.decryptFile(this.message);

        if (file) {
            const file = `${this.id}.${mime.extension(this.message.mimetype)}`;

            try {
                await tools.writeFile(`./temp/${file}`, decryptFile, async (err) => {
                    if (err) {
                        throw (err);
                    }
                });
                tools.conlog_info_force(`[${this.id}] File downloaded and saved`);
            } catch (err) {
                tools.conlog_error(`[${this.id}] ${err}`);
            }

            return file;
        } else {
            tools.conlog_info_force(`[${this.id}] File downloaded`);

            return decryptFile;
        }
    }

    async sendImage() {
        await this.client
            .sendImageAsSticker(this.message.chatId, `${this.image.dir}${this.image.file}`)
            .then((result) => {
                if (config.debug) {
                    console.log(result);
                }
                tools.conlog_info_force(`[${this.id}] Sticker sent`);
            })
            .catch((err) => {
                tools.conlog_error(`[${this.id}] Error when sending: ${err.toString()}`);
            });
    }

    async sendVideo(file) {
        await this.client
            .sendImageAsStickerGif(this.message.chatId, `${this.video.dir}${file}`)
            .then((result) => {
                if (config.debug) {
                    console.log(result);
                }
                tools.conlog_info_force(`[${this.id}] Sticker sent`);
            })
            .catch((err) => {
                tools.conlog_error(`[${this.id}] Error when sending: ${err.toString()}`);
            });
    }
}

module.exports = {
    Whatsapp,
    Message_was
}