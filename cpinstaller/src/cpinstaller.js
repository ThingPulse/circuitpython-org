'use strict';
import {html, render} from 'https://unpkg.com/lit-html?module';
import * as esptoolPackage from "https://unpkg.com/esp-web-flasher@5.1.2/dist/web/index.js?module"

// TODO: Figure out how to make the Web Serial from ESPTool and Web Serial to communicate with CircuitPython not conflict
// I think at the very least we'll have to reuse the same port so the user doesn't need to reselct, though it's possible it
// may change after reset. Since it's not
//
// For now, we'll use the following procedure for ESP32-S2 and ESP32-S3:
// 1. Install the bin file
// 2. Reset the board
// (if version 8.0.0-beta.6 or later)
// 3. Generate the settings.toml file
// 4. Write the settings.toml to the board via the REPL
// 5. Reset the board again
//
// For the esp32 and esp32c3, the procedure may be slightly different and going through the
// REPL may be required for the settings.toml file.
// 1. Install the bin file
// 2. Reset the board
// (if version 8.0.0-beta.6 or later)
// 3. Generate the settings.toml file
// 4. Write the settings.toml to the board via the REPL
// 5. Reset the board again
//
// To run REPL code, I may need to modularize the work I did for code.circuitpython.org
// That allows you to run code in the REPL and get the output back. I may end up creating a
// library that uses Web Serial and allows you to run code in the REPL and get the output back
// because it's very integrated into the serial recieve and send code.
//

let espStub;

const baudRates = [
  115200,
  230400,
  460800,
  921600,
];

const CSS_DIALOG_CLASS = "cp-installer-dialog";

export class CPInstallButton extends HTMLButtonElement {
    static isSupported = 'serial' in navigator;

    static isAllowed = window.isSecureContext;

    constructor() {
        super();
        this.dialogElements = {};
        this.currentFlow = null;
        this.currentStep = 0;
        this.currentDialogElement = null;
        this.boardName = "ESP32-based board";
        this.preloadDialogs();
    }

    // These are a series of the valid steps that should be part of a program flow
    flows = {
        binProgram: {
            label: "Install Bin File",
            steps: [this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepFlashBin, this.stepSuccess],
        },
        uf2Program: {
            label: "Install Bootloader and uf2",
            steps: [this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepBootloader, this.stepCopyUf2, this.stepSettings, this.stepSuccess],
        },
        bootloaderOnly: {
            label: "Install Bootloader Only",
            steps: [this.stepSerialConnect, this.stepConfirm, this.stepEraseAll, this.stepBootloader, this.stepSuccess],
        },
        settingsOnly: {
            label: "Update WiFi credentials",
            steps: [this.stepSerialConnect, this.stepCredentials, this.stepSettings, this.stepSuccess],
        }
    }

    // Define some common buttons
    /* Buttons should have a label, and a callback and optionally a condition function on whether they should be enabled */
    previousButton = {
        label: "Previous",
        callback: this.prevStep,
        enabled: () => { return this.currentStep > 0 },
    }

    nextButton = {
        label: "Next",
        callback: this.nextStep,
        enabled: () => { return this.currentStep < this.currentFlow.steps.length - 1; },
    }

    closeButton = {
        label: "Close",
        callback: async (e) => {
            this.closeDialog();
        }
    }

    // Default Buttons
    defaultButtons = [this.previousButton, this.nextButton];

    // This is the data for the dialogs
    dialogs = {
        notSupported: {
            preload: false,
            template: (data) => html`
            Sorry, <b>Web Serial</b> is not supported on your browser at this time. Browsers we expect to work:
            <ul>
            <li>Google Chrome 89 (and higher)</li>
            <li>Microsoft Edge 89 (and higher)</li>
            <li>Opera 75 (and higher)</li>
            </ul>
            `,
            buttons: [this.closeButton],
        },
        menu: {
            // TODO: This might be a good place for a directive
            template: (data) => html`
                Install Bin File
                Install Bootloader and uf2 (If we have a bootloader file)
                Update WiFi credentials (Only if cp8 is detected)
            `,
            buttons: [this.closeButton],
        },
        serialConnect: {
            template: (data) => html`
                <p>
                    Welcome to the CircuitPython Installer. This tool will install CircuitPython on your ${data.boardName}.
                </p>
                <p>Make sure your board is plugged into this computer via a Serial connection using a USB Cable.
                </p>
                <ul>
                    <li><em><strong>NOTE:</strong> A lot of people end up using charge-only USB cables and it is very frustrating! Make sure you have a USB cable you know is good for data sync.</em></li>
                </ul>
                `,
        },
        confirm: {
            template: (data) => html`
                <p>This will overwrite everything on the ${data.boardName}.</p>
            `,
            buttons: [
                {
                    label: "Cancel",
                    callback: async (e) => {
                        this.closeDialog();
                    }
                },
                {
                    label: "Continue",
                    callback: this.nextStep,
                }
            ],
        },
        erase: {
            template: (data) => html`
                <p>Erasing Flash...</p>
                <progress id="eraseProgress" max="100" value="${data.percentage}"> ${data.percentage}% </progress>
            `,
            closeable: false,
            buttons: [this.nextButton],
        },
        flash: {
            template: (data) => html`
                <p>Flashing ${data.contents}...</p>
                <progress id="flashProgress" max="100" value="${data.percentage}"> ${data.percentage}% </progress>
            `,
            closeable: false,
            buttons: [this.nextButton],
        },
        // We may have a waiting for Bootloader to start dialog
        copyUf2: {
            template: (data) => html`
                <p>Copying ${data.uf2file}...</p>
                <progress id="copyProgress" max="100" value="${data.percentage}"> ${data.percentage}% </progress>
            `,
            closeable: false,
            buttons: [this.nextButton],
        },
        credentials: {
            template: (data) => html`
                <div class="field">
                  <label><span>WiFi Network Name (SSID):</span>
                    <input id="network_type_wifi.network_ssid" class="partition-data" type="text" placeholder="WiFi SSID" value="" />
                  </label>
                </div>
                <div class="field">
                  <label><span>WiFi Password:</span>
                    <input id="network_type_wifi.network_password" class="partition-data" type="text" placeholder="WiFi Password" value=""  />
                  </label>
                </div>
                <div class="field">
                  <label><span>Web Workflow Password:</span>
                    <input id="web_workflow_password" class="partition-data" type="text" placeholder="Web Workflow Password" value=""  />
                  </label>
                </div>
            `,
        },
        circuitPythonCheck: {
            template: (data) => html`
                <p>Looking for CircuitPython...</p>
                <progress id="copyProgress" max="100" value="${data.percentage}"> ${data.percentage}% </progress>
            `,
        },
        generateSettings: {
            template: (data) => html`
                <p>Generating settings.toml...</p>
                <progress id="copyProgress" max="100" value="${data.percentage}"> ${data.percentage}% </progress>
            `,
        },
        success: {
            template: (data) => html`
                <p>Successfully Completed Installation</p>
            `,
            buttons: [this.closeButton],
        },
        error: {
            template: (data) => html`
                <p>Installation Error: ${data.message}</p>
            `,
            step: false,
            buttons: [this.closeButton],
        },
    }

    connectedCallback() {
        if (!CPInstallButton.isSupported || !CPInstallButton.isAllowed) {
            this.toggleAttribute("install-unsupported", true);
            this.innerHTML = !CPInstallButton.isAllowed
              ? "<slot name='not-allowed'>You can only install ESP devices on HTTPS websites or on the localhost.</slot>"
              : "<slot name='unsupported'>Your browser does not support installing things on ESP devices. Use Google Chrome or Microsoft Edge.</slot>";
            return;
        }

        this.toggleAttribute("install-supported", true);
        this.boardName = this.getAttribute("boardname") || "ESP32-based device";

        // If either of these are empty, it's a problem
        this.boardId = this.getAttribute("boardid");
        this.firmwareUrl = this.getAttribute("firmware");

        this.addEventListener("click", async (e) => {
            e.preventDefault();
            await this.runFlow(this.flows.binProgram);
        });
    }

    preloadDialogs() {
        for (const [id, dialog] of Object.entries(this.dialogs)) {
            if ('preload' in dialog && !dialog.preload) {
                continue;
            }
            this.dialogElements[id] = this.getDialogElement(dialog);
        }
    }

    createIdFromLabel(text) {
        return text.replace(/^[^a-z]+|[^\w:.-]+/gi, "");
    }

    createDialogElement(id, dialogData) {
        // Check if an existing dialog with the same id exists and remove it if so
        let existingDialog = this.querySelector(`#cp-installer-${id}`);
        if (existingDialog) {
            this.remove(existingDialog);
        }

        // Create a dialog element
        let dialogElement = document.createElement("dialog");
        dialogElement.id = id;
        dialogElement.classList.add(CSS_DIALOG_CLASS);

        // Add a close button
        let closeButton = document.createElement("button");
        closeButton.href = "#";
        closeButton.classList.add("close-button");
        closeButton.addEventListener("click", (e) => {
            e.preventDefault();
            dialogElement.close();
        });
        dialogElement.appendChild(closeButton);

        // Add a body element
        let body = document.createElement("div");
        body.classList.add("dialog-body");
        dialogElement.appendChild(body);

        // Add buttons according to config data
        let navigation = document.createElement("div");
        navigation.classList.add("dialog-navigation");

        let buttons = this.defaultButtons;
        if (dialogData && dialogData.buttons) {
            buttons = dialogData.buttons;
        }

        for (const button of buttons) {
            let buttonElement = document.createElement("button");
            buttonElement.innerText = button.label;
            buttonElement.id = this.createIdFromLabel(button.label);
            buttonElement.addEventListener("click", async (e) => {
                e.preventDefault();
                await button.callback.bind(this)();
            });
            navigation.appendChild(buttonElement);
        }
        dialogElement.appendChild(navigation);

        // Return the dialog element
        document.body.appendChild(dialogElement);
        return dialogElement;
    }

    getDialogElement(dialog, forceReload = false) {
        function getKeyByValue(object, value) {
            return Object.keys(object).find(key => object[key] === value);
        }

        const dialogId = getKeyByValue(this.dialogs, dialog);

        if (dialogId) {
            if (dialogId in this.dialogElements && !forceReload) {
                return this.dialogElements[dialogId];
            } else {
                return this.createDialogElement(dialogId, dialog);
            }
        }
        return null;
    }

    showDialog(dialog, templateData = {}) {
        let dialogButtons;

        if (this.currentDialogElement) {
            this.closeDialog();
        }

        this.currentDialogElement = this.getDialogElement(dialog);
        if (!this.currentDialogElement) {
            console.error(`Dialog not found`);
        }

        if (this.currentDialogElement) {
            const dialogBody = this.currentDialogElement.querySelector(".dialog-body");
            if ('template' in dialog) {
                render(dialog.template(templateData), dialogBody);
            }

            // Close button should probably hide during certain steps such as flashing and erasing
            if ("closeable" in dialog && !dialog.closeable) {
                this.currentDialogElement.querySelector(".close-button").style.display = "none";
            } else {
                this.currentDialogElement.querySelector(".close-button").style.display = "block";
            }

            if ('buttons' in dialog) {
                dialogButtons = dialog.buttons;
            } else {
                dialogButtons = this.defaultButtons;
            }

            for (const button of dialogButtons) {
                const buttonid = this.createIdFromLabel(button.label);

                let buttonElement = this.currentDialogElement.querySelector(`#${buttonid}`);
                if (buttonElement && "enabled" in button) {
                    console.log(button, button.enabled());
                    buttonElement.disabled = !button.enabled();
                }
            }

            this.currentDialogElement.showModal();
        }
    }

    closeDialog() {
        this.currentDialogElement.close();
        this.currentDialogElement = null;
    }

    async runFlow(flow) {
        this.currentFlow = flow;
        this.currentStep = 0;
        await this.currentFlow.steps[this.currentStep].bind(this)();
    }

    async nextStep() {
        if (!this.currentFlow) {
            return;
        }

        if (this.currentStep < this.currentFlow.steps.length) {
            this.currentStep++;
            await this.currentFlow.steps[this.currentStep].bind(this)();
        }
    }

    async prevStep() {
        if (!this.currentFlow) {
            return;
        }

        if (this.currentStep > 0) {
            this.currentStep--;
            await this.currentFlow.steps[this.currentStep].bind(this)();
        }
    }

    async stepSerialConnect() {
        // Display Serial Connect Text
        this.showDialog(this.dialogs.serialConnect, {boardName: this.boardName});
    }

    async stepConfirm() {
        // Display Confirm Step
        this.showDialog(this.dialogs.confirm, {boardName: this.boardName});
    }

    async stepEraseAll() {
        // Display EraseAll Step
        this.showDialog(this.dialogs.erase);

        // TODO: This should go to the next step automatically when finished
    }

    async stepFlashBin() {
        // Display FlashBin Step
        this.showDialog(this.dialogs.flash, {contents: "Bin File"});

        // TODO: This should go to the next step automatically when finished
    }

    async stepBootloader() {
        // Display Bootloader Step
        this.showDialog(this.dialogs.flash, {contents: "Bootloader"});
    }

    async stepCopyUf2() {
        // Display CopyUf2 Step
        this.showDialog(this.dialogs.copyUf2);
    }

    async stepSettings() {
        // Display Settings Step
        this.showDialog(this.dialogs.settings);
    }

    async stepCredentials() {
        // Display Credentials Step
        this.showDialog(this.dialogs.credentials);
    }

    async stepSuccess() {
        // Display Success Step
        this.showDialog(this.dialogs.success);
    }

    async stepClose() {
        // Close the currently loaded dialog
        this.closeDialog();
    }
}

customElements.define('cp-install-button', CPInstallButton, {extends: "button"});

// Wizard screens
// - Menu
// - Verify user wants to install
// - erase flash
// - if esp32 or c3 flash bin
// - if s2 or s3, flash bootloader
// - if s2 or s3, copy uf2 (May need to use File System Access API)
// - request wifi credentials (skip, connect buttons) and AP password
// - generate and program settings.toml via REPL
// - install complete

// So we will have a couple of wizard flows and we'll need to associate the flow with the board
// We should add the info to the board's page in the boards folder

// Changes to make:
// Hide the log and make it accessible via the menu
// Generate dialogs on the fly
// Make a drop-in component
// Keep in mind it will be used for LEARN too
// May need to deal with CORS issues
// May need to deal with the fact that the ESPTool uses Web Serial and CircuitPython REPL uses Web Serial

/*
const maxLogLength = 100;
const installerDialog = document.getElementById('installerDialog');
const butInstallers = document.getElementsByClassName("installer-button");

const log = installerDialog.querySelector("#log");
const semverLabel = installerDialog.querySelector("#semver");
//const butShowConsole = installerDialog.querySelector("#butShowConsole");
const consoleItems = installerDialog.getElementsByClassName("console-item");
const butConnect = installerDialog.querySelector("#butConnect");
const binSelector = installerDialog.querySelector("#binSelector");
const baudRate = installerDialog.querySelector("#baudRate");
const butClear = installerDialog.querySelector("#butClear");
const butProgram = installerDialog.querySelector("#butProgram");
const butProgramBootloader = installerDialog.querySelector("#butProgramBootloader");
const autoscroll = installerDialog.querySelector("#autoscroll");

const partitionData = installerDialog.querySelectorAll(".field input.partition-data");
const progress = installerDialog.querySelector("#progressBar");
const stepname = installerDialog.querySelector("#stepname");
const appDiv = installerDialog.querySelector("#app");

const disableWhileBusy = [partitionData, butProgram, butProgramBootloader, baudRate];

let showConsole = false;
let debug;

// querystring options
const QUERYSTRING_BOARD_KEY = 'board'
const QUERYSTRING_DEBUG_KEY = 'debug'

function getFromQuerystring(key) {
    const location = new URL(document.location)
    const params = new URLSearchParams(location.search)
    return params.get(key)
}

for (let installer of butInstallers) {
    installer.addEventListener("click", (e) => {
        let installerName = e.target.id;
        installerDialog.showModal();
        e.preventDefault();
        e.stopImmediatePropagation();
    });
}

document.addEventListener("DOMContentLoaded", () => {
    // detect debug setting from querystring
    debug = getFromQuerystring(QUERYSTRING_DEBUG_KEY);
    var getArgs = {};
    location.search
        .substr(1)
        .split("&")
        .forEach(function (item) {
            getArgs[item.split("=")[0]] = item.split("=")[1];
        });
    if (getArgs["debug"] !== undefined) {
        debug = getArgs["debug"] == "1" || getArgs["debug"].toLowerCase() == "true";
    }

    // register dom event listeners
    butConnect.addEventListener("click", () => {
        clickConnect().catch(async (e) => {
            // Default Help Message:
            // if we've failed to catch the message before now, we need to give
            // the generic advice: reconnect, refresh, go to support
            errorMsg(
                `Connection Error, your board may be incompatible. Things to try:\n` +
                `1. Reset your board and try again.\n` +
                `  - Look for a little black button near the power port.\n` +
                `2. Refresh your browser and try again.\n` +
                `3. Make sure you are not connected in another browser tab.\n` +
                `4. Double-check your board type and serial port selection.\n` +
                `5. Post on the Support Forum (link above) with this info:\n\n` +
                `"Firmware Tool: ${e}"\n`
            );
            await disconnect();
            toggleUIConnected(false);
        });
    });
    //butClear.addEventListener("click", clickClear);
    butProgram.addEventListener("click", clickProgram);
    butProgramBootloader.addEventListener("click", clickProgramNvm);
    for (let i = 0; i < partitionData.length; i++) {
        partitionData[i].addEventListener("change", checkProgrammable);
        partitionData[i].addEventListener("keydown", checkProgrammable);
        partitionData[i].addEventListener("input", checkProgrammable);
    }
    //autoscroll.addEventListener("click", clickAutoscroll);
    //baudRate.addEventListener("change", changeBaudRate);

    // handle runaway errors
    window.addEventListener("error", event => {
        console.warn(`Uncaught error: ${event.error}`);
    });

    // handle runaway rejections
    window.addEventListener("unhandledrejection", event => {
        console.warn(`Unhandled rejection: ${event.reason}`);
    });

    // WebSerial feature detection
    if ("serial" in navigator) {
        const notSupported = document.getElementById("notSupported");
        notSupported.classList.add("hidden");
    }

    //initBinSelector();
    //initBaudRate();
    loadAllSettings();
    logMsg("CircuitPython ESP32 Installer loaded.");
    checkProgrammable();
});

function createOption(value, text) {
    const option = document.createElement("option");
    option.text = text;
    option.value = value;
    return option;
}

let latestFirmwares = []

function returnToStepOne() {
    showStep(1, { hideHigherSteps: false });
    doThingOnClass("add", "dimmed", "step-2")
    // yellow fade like 2005
    setTimeout(() => doThingOnClass("add", "highlight", "step-1"), 0)
    setTimeout(() => doThingOnClass("remove", "highlight", "step-1"), 1500)
    doThingOnClass("add", "hidden", "step-1 alt")
}

function showAltStepOne() {
    doThingOnClass("add", "hidden", "step-1")
    doThingOnClass("remove", "hidden", "step-1 alt")
}

function doThingOnClass(method, thing, classSelector) {
    const classItems = document.getElementsByClassName(classSelector)
    for (let idx = 0; idx < classItems.length; idx++) {
        classItems.item(idx).classList[method](thing)
    }
}

function setDefaultBoard() {
    const board = getFromQuerystring(QUERYSTRING_BOARD_KEY)
    if (board && hasBoard(board)) {
        binSelector.value = board
        showStep(2, { dimLowerSteps: false })
        return true
    }
}

function hasBoard(board) {
    for (let opt of binSelector.options) {
        if (opt.value == board) { return opt }
    }
}

function changeBin(evt) {
    (evt.target.value && evt.target.value != "null") ?
        showStep(2) :
        hideStep(2)
}

function showStep(stepNumber, options={}) {
    const dimLowerSteps = !(options.dimLowerSteps === false)
    const hideHigherSteps = !(options.hideHigherSteps === false)
    // reveal the new step
    doThingOnClass("remove", "hidden", `step-${stepNumber}`)
    doThingOnClass("remove", "dimmed", `step-${stepNumber}`)

    if (dimLowerSteps) {
        for (let step = stepNumber - 1; step > 0; step--) {
            doThingOnClass("add", "dimmed", `step-${step}`)
        }
    }

    if (hideHigherSteps) {
      for (let step = stepNumber + 1; step <= 6; step++) {
          doThingOnClass("add", "hidden", `step-${step}`)
      }
    }

    // per-step things, like a state machine
    switch(stepNumber) {
        case 3:
            checkProgrammable()
            break;
        case 4:
            butProgram.disabled = false
            butProgramNvm.disabled = false
            break;
    }

    // scroll to the bottom next frame
    setTimeout((() => appDiv.scrollTop = appDiv.scrollHeight), 0)
}

function hideStep(stepNumber) {
    doThingOnClass("add", "hidden", `step-${stepNumber}`)
}

function toggleConsole(show) {
    // hide/show the console log and its widgets
    const consoleItemsMethod = show ? "remove" : "add"
    for (let idx = 0; idx < consoleItems.length; idx++) {
        consoleItems.item(idx).classList[consoleItemsMethod]("hidden")
    }
    // toggle the button
    //butShowConsole.checked = show
    // tell the app if it's sharing space with the console
    const appDivMethod = show ? "add" : "remove"
    appDiv.classList[appDivMethod]("with-console")

    // scroll both to the bottom a moment after adding
    setTimeout(() => {
        log.scrollTop = log.scrollHeight
        appDiv.scrollTop = appDiv.scrollHeight
    }, 200)
}

let semver
function initSemver(newSemver) {
    if (!newSemver) { return }

    semver = newSemver
    semverLabel.innerHTML = semver

    return true
}

function lookupFirmwareByBinSelector() {
    // get the currently selected board id
    const selectedId = binSelector.value
    if (!selectedId || selectedId === 'null') { throw new Error("No board selected.") }

    // grab the stored firmware settings for this id
    let selectedFirmware
    for (let firmware of latestFirmwares) {
        if (firmware.id === selectedId) {
            selectedFirmware = firmware
            break
        }
    }

    if (!selectedFirmware) {
        const { text, value } = binSelector.selectedOptions[0]
        throw new Error(`No firmware entry for: ${text} (${value})`)
    }

    return selectedFirmware
}

function initBaudRate() {
    for (let rate of baudRates) {
        baudRate.add(createOption(rate, `${rate} Baud`));
    }
}

let lastPercent = 0;

async function disconnect() {
    toggleUIToolbar(false);
    if (espStub) {
        await espStub.disconnect();
        await espStub.port.close();
        toggleUIConnected(false);
        espStub = undefined;
    }
}

function logMsg(text) {
    log.innerHTML += text.replaceAll("\n", "<br>") + "<br>";

    // Remove old log content
    if (log.textContent.split("\n").length > maxLogLength + 1) {
        let logLines = log.innerHTML.replace(/(\n)/gm, "").split("<br>");
        log.innerHTML = logLines.splice(-maxLogLength).join("<br>\n");
    }

}

function debugMsg(...args) {
    function getStackTrace() {
        let stack = new Error().stack;
        stack = stack.split("\n").map((v) => v.trim());
        for (let i = 0; i < 3; i++) {
            stack.shift();
        }

        let trace = [];
        for (let line of stack) {
            line = line.replace("at ", "");
            trace.push({
                func: line.substr(0, line.indexOf("(") - 1),
                pos: line.substring(line.indexOf(".js:") + 4, line.lastIndexOf(":")),
            });
        }

        return trace;
    }

    let stack = getStackTrace();
    stack.shift();
    let top = stack.shift();
    let prefix = '<span class="debug-function">[' + top.func + ":" + top.pos + "]</span> ";
    for (let arg of args) {
        if (typeof arg == "string") {
            logMsg(prefix + arg);
        } else if (typeof arg == "number") {
            logMsg(prefix + arg);
        } else if (typeof arg == "boolean") {
            logMsg(prefix + arg ? "true" : "false");
        } else if (Array.isArray(arg)) {
            logMsg(prefix + "[" + arg.map((value) => espStub.toHex(value)).join(", ") + "]");
        } else if (typeof arg == "object" && arg instanceof Uint8Array) {
            logMsg(
                prefix +
                    "[" +
                    Array.from(arg)
                        .map((value) => espStub.toHex(value))
                        .join(", ") +
                    "]"
            );
        } else {
            logMsg(prefix + "Unhandled type of argument:" + typeof arg);
            console.log(arg);
        }
        prefix = ""; // Only show for first argument
    }
}

function errorMsg(text, forwardLink=null) {
    // regular log with red Error: prefix
    logMsg('<span class="error-message">Error:</span> ' + text);
    // strip html for console and alerts
    const strippedText = text.replaceAll(/<.*?>/g, "")
    // all errors go to the browser dev console
    console.error(strippedText);
    // Make sure user sees the error if the log is closed
    if (!showConsole) {
      if (forwardLink) {
        if (confirm(`${strippedText}\nClick 'OK' to be forwarded there now.`)) {
          document.location = forwardLink
        }
      } else {
        alert(strippedText)
      }
    }
}

function formatMacAddr(macAddr) {
    return macAddr.map((value) => value.toString(16).toUpperCase().padStart(2, "0")).join(":");
}

async function reset() {
    // Clear the log
    log.innerHTML = "";
}

async function clickConnect() {
    await disconnect();

    butConnect.textContent = "Connecting...";
    butConnect.disabled = true

    const esploader = await esptoolPackage.connect({
        log: (...args) => logMsg(...args),
        debug: debug ? (...args) => debugMsg(...args) : (...args) => {},
        error: (...args) => errorMsg(...args),
    });

    try {
        await esploader.initialize();

        const chipType = esploader.chipFamily;
        const chipName = esploader.chipName;
        toggleUIConnected(true);
        toggleUIToolbar(true);
        appDiv.classList.add("connected");

        logMsg("Connected to " + esploader.chipName);
        logMsg("MAC Address: " + formatMacAddr(esploader.macAddr()));

        const nextStepCallback = async () => {
            showStep(3)
            espStub = await esploader.runStub();
            espStub.addEventListener("disconnect", () => {
              toggleUIConnected(false);
              espStub = false;
            });
            await setBaudRateIfChipSupports(chipType);
        }

        // check chip compatibility
        if (checkChipTypeMatchesSelectedBoard(chipType)) {
            await nextStepCallback()
            return
        }

        // not compatible, grab the board name for messaging...
        const boardName = lookupFirmwareByBinSelector().name
        // ...and reset the selector to only compatible boards, if any!
        const any = populateBinSelector(`Possible ${chipName} Boards:`, firmware => {
            return (BOARD_TO_CHIP_MAP[firmware.id] == chipType)
        })

        if (any) {
          // there are compatible boards available
          // reset the bin selector
          binSelector.disabled = false
          binSelector.removeEventListener("change", changeBin);
          binSelector.addEventListener("change", async evt => {
              // upon compatible board selection, reveal next step
              if (evt.target.value && evt.target.value != "null" && checkChipTypeMatchesSelectedBoard(chipType)) {
                  logMsg(`Compatible board selected: <strong>${boardName}</strong>`)
                  await nextStepCallback()
              }
          });

          // explain all this to the user
          errorMsg(`Oops, wrong board!\n` +
            `- you selected: <strong>${boardName}</strong>\n` +
            `- you connected: <strong>${chipName}</strong>\n` +
            `You can:\n` +
            `- go back to Step 1 and select a compatible board\n` +
            `- connect a different board and refresh the browser`)

          // reveal step one
          returnToStepOne()
          return
        }

        // no compatible boards available
        // explain to the user with a link to the appropriate guide
        errorMsg(`Oops! This tool doesn't support your board, <strong>${chipName}</strong>, but WipperSnapper still might!\n` +
          `Visit <a href="${QUICK_START_LINK}">the quick-start guide</a> for a list of supported boards and their install instructions.`, QUICK_START_LINK)
        // can't use it so disconnect now
        await disconnect()

    } catch (err) {
        await esploader.disconnect();
        // Disconnection before complete
        toggleUIConnected(false);
        showStep(2, { hideHigherSteps: true })
        errorMsg("Oops, we lost connection to your board before completing the install. Please check your USB connection and click Connect again. Refresh the browser if it becomes unresponsive.")
    }
}

function checkChipTypeMatchesSelectedBoard(chipType, boardId=null) {
    // allow overriding which board we're checking against
    boardId = boardId || binSelector.value
    // wrap the lookup
    return (BOARD_TO_CHIP_MAP[boardId] == chipType)
}

async function setBaudRateIfChipSupports(chipType) {
    const baud = parseInt(baudRate.value);
    if (baud == espStub.ESP_ROM_BAUD) { return } // already the default

    if (chipType == espStub.ESP32) { // only supports the default
        logMsg("WARNING: ESP32 is having issues working at speeds faster than 115200. Continuing at 115200 for now...");
        return
    }

    await changeBaudRate(baud);
}

async function changeBaudRate() {
    saveSetting("baudrate", baudRate.value);
    if (espStub) {
        let baud = parseInt(baudRate.value);
        if (baudRates.includes(baud)) {
            await espStub.setBaudrate(baud);
        }
    }
}

async function clickAutoscroll() {
    saveSetting("autoscroll", autoscroll.checked);
}

async function clickProgram() {
    await programScript(full_bin_program);
}

async function clickProgramNvm() {
    await programScript(factory_reset_program);
}

async function populateSecretsFile(path) {
    let response = await fetch(path);
    let contents = await response.json();

    // Get the secrets data
    for (let field of getValidFields()) {
        const { id, value } = partitionData[field]
        if(id === "status_pixel_brightness") {
            const floatValue = parseFloat(value)
            updateObject(contents, id, isNaN(floatValue) ? 0.2 : floatValue);
        } else {
            updateObject(contents, id, value);
        }
    }

    // Convert the data to text and return
    return JSON.stringify(contents, null, 4);
}

function updateObject(obj, path, value) {
    if (typeof obj === "undefined") {
        return false;
    }

    var _index = path.indexOf(".");
    if (_index > -1) {
        return updateObject(obj[path.substring(0, _index)], path.substr(_index + 1), value);
    }

    obj[path] = value;
}


let chipFiles
async function fetchFirmwareForSelectedBoard() {
    const firmware = lookupFirmwareByBinSelector()

    logMsg(`Fetching latest firmware...`)
    const response = await fetch(`${FIRMWARE_API}/wipper_releases/${firmware.id}`, {
        headers: { Accept: 'application/octet-stream' }
    })

    // Zip stuff
    logMsg("Unzipping firmware bundle...")
    const blob = await response.blob()
    const reader = new zip.ZipReader(new zip.BlobReader(blob));

    // unzip into local file cache
    chipFiles = await reader.getEntries();
}

const BASE_SETTINGS = {
    files: [
        {
            filename: "secrets.json",
            callback: populateSecretsFile,
        },
    ],
    rootFolder: "files",
};

function findInZip(filename) {
    const regex = RegExp(filename.replace("VERSION", "(.*)"))
    for (let i = 0; i < chipFiles.length; i++) {
        if (chipFiles[i].filename.match(regex)) {
            return chipFiles[i]
        }
    }
}

async function mergeSettings() {
    const { settings } = lookupFirmwareByBinSelector()

    const transformedSettings = {
        ...settings,
        // convert the offset value from hex string to number
        offset: parseInt(settings.offset, 16),
        // replace the structure object with one where the keys have been converted
        // from hex strings to numbers
        structure: Object.keys(settings.structure).reduce((newObj, hexString) => {
            // new object, converted key (hex string -> numeric), same value
            newObj[parseInt(hexString, 16)] = settings.structure[hexString]

            return newObj
        }, {})
    }

    // merge with the defaults and send back
    return {
        ...BASE_SETTINGS,
        ...transformedSettings
    }
}

async function programScript(stages) {
    butProgram.disabled = true
    butProgramNvm.disabled = true
    try {
        await fetchFirmwareForSelectedBoard()
    } catch(error) {
        errorMsg(error.message)
        return
    }

    // pretty print the settings object with VERSION placeholders filled
    const settings = await mergeSettings()
    const settingsString = JSON.stringify(settings, null, 2)
    const strippedSettings = settingsString.replaceAll('VERSION', semver)
    logMsg(`Flashing with settings: <pre>${strippedSettings}</pre>`)

    let steps = [];
    for (let i = 0; i < stages.length; i++) {
        if (stages[i] == stage_erase_all) {
            steps.push({
                name: "Erasing Flash",
                func: async function () {
                    await espStub.eraseFlash();
                },
                params: {},
            });
        } else if (stages[i] == stage_flash_cpbin) {
            for (const [offset, filename] of Object.entries(settings.structure)) {
                steps.push({
                    name: "Flashing " + filename.replace('VERSION', semver),
                    func: async function (params) {
                        const firmware = await getFirmware(params.filename);
                        const progressBar = progress.querySelector("div");
                        lastPercent = 0;
                        await espStub.flashData(
                            firmware,
                            (bytesWritten, totalBytes
                            ) => {
                                let percentage = Math.floor((bytesWritten / totalBytes) * 100)
                                if (percentage != lastPercent) {
                                    logMsg(`${percentage}% (${bytesWritten}/${totalBytes})...`);
                                    lastPercent = percentage;
                                }
                                progressBar.style.width = percentage + "%";
                            },
                            params.offset,
                            0
                        );
                    },
                    params: {
                        filename: filename,
                        offset: offset,
                    },
                });
            }
        } else if (stages[i] == stage_flash_bootloader) {
            for (const [offset, filename] of Object.entries(settings.structure)) {
                steps.push({
                    name: "Flashing " + filename.replace('VERSION', semver),
                    func: async function (params) {
                        const firmware = await getFirmware(params.filename);
                        const progressBar = progress.querySelector("div");
                        lastPercent = 0;
                        await espStub.flashData(
                            firmware,
                            (bytesWritten, totalBytes
                            ) => {
                                let percentage = Math.floor((bytesWritten / totalBytes) * 100)
                                if (percentage != lastPercent) {
                                    logMsg(`${percentage}% (${bytesWritten}/${totalBytes})...`);
                                    lastPercent = percentage;
                                }
                                progressBar.style.width = percentage + "%";
                            },
                            params.offset,
                            0
                        );
                    },
                    params: {
                        filename: filename,
                        offset: offset,
                    },
                });
            }
        } else if (stages[i] == stage_program_settings) {
            // TODO: This needs to be rewritten to talk with circuitpython
            // and run python code via the repl to write a settings.toml file
            // See https://learn.adafruit.com/circuitpython-with-esp32-quick-start/setting-up-web-workflow
            // and https://github.com/circuitpython/web-editor/pull/46
            steps.push({
                name: "Generating and Writing the WiFi Settings",
                func: async function (params) {
                    let fileSystemImage = await generate(params.flashParams);

                    if (DO_DOWNLOAD) {
                        // Download the Partition
                        var blob = new Blob([new Uint8Array(fileSystemImage)], {
                            type: "application/octet-stream",
                        });
                        var link = document.createElement("a");
                        link.href = window.URL.createObjectURL(blob);
                        link.download = "littleFS.bin";
                        link.click();
                        link.remove();
                    } else {
                        const progressBar = progress.querySelector("div");
                        lastPercent = 0;
                        await espStub.flashData(
                            new Uint8Array(fileSystemImage).buffer,
                            (bytesWritten, totalBytes) => {
                                let percentage = Math.floor((bytesWritten / totalBytes) * 100)
                                if (percentage != lastPercent) {
                                    logMsg(`${percentage}% (${bytesWritten}/${totalBytes})...`);
                                    lastPercent = percentage;
                                }
                                progressBar.style.width = percentage + "%";
                            },
                            params.flashParams.offset,
                            0
                        );
                    }
                },
                params: {
                    flashParams: settings,
                },
            });
        }
    }

    for (let i = 0; i < disableWhileBusy.length; i++) {
        if (Array.isArray(disableWhileBusy[i])) {
            for (let j = 0; j < disableWhileBusy[i].length; i++) {
                disableWhileBusy[i][j].disable = true;
            }
        } else {
            disableWhileBusy[i].disable = true;
        }
    }

    progress.classList.remove("hidden");
    stepname.classList.remove("hidden");
    showStep(5)

    for (let i = 0; i < steps.length; i++) {
        stepname.innerText = steps[i].name + " (" + (i + 1) + "/" + steps.length + ")...";
        await steps[i].func(steps[i].params);
    }

    stepname.classList.add("hidden");
    stepname.innerText = "";
    progress.classList.add("hidden");
    progress.querySelector("div").style.width = "0";

    for (let i = 0; i < disableWhileBusy.length; i++) {
        if (Array.isArray(disableWhileBusy[i])) {
            for (let j = 0; j < disableWhileBusy[i].length; i++) {
                disableWhileBusy[i][j].disable = false;
            }
        } else {
            disableWhileBusy[i].disable = false;
        }
    }

    checkProgrammable();
    await disconnect();
    logMsg("To run the new firmware, please reset your device.");
    showStep(6);
}

function getValidFields() {
    // Validate user inputs
    const validFields = [];
    for (let i = 0; i < 3; i++) {
        const { id, value } = partitionData[i]
        // password & brightness can be blank, the rest must have some value
        if (id === "network_type_wifi.network_password" ||
            value.length > 0) {
            validFields.push(i);
        }
    }
    return validFields;
}

async function checkProgrammable() {
    if (getValidFields().length < 5) {
      hideStep(4)
    } else {
      showStep(4, { dimLowerSteps: false })
    }
}

async function clickClear() {
    reset();
}

function toggleUIToolbar(show) {
    for (let i = 0; i < 4; i++) {
        progress.classList.add("hidden");
        progress.querySelector("div").style.width = "0";
    }
    if (show) {
        appDiv.classList.add("connected");
    } else {
        appDiv.classList.remove("connected");
    }
}

function toggleUIConnected(connected) {
    let lbl = "Connect";
    if (connected) {
        lbl = "Connected";
        butConnect.disabled = true
        binSelector.disabled = true
    } else {
        toggleUIToolbar(false);
        butConnect.disabled = false
        binSelector.disabled = false
    }
    butConnect.textContent = lbl;
}

function loadAllSettings() {
    // Load all saved settings or defaults
    //autoscroll.checked = loadSetting("autoscroll", true);
    //baudRate.value = loadSetting("baudrate", baudRates[0]);
    showConsole = loadSetting('showConsole', false);
    toggleConsole(showConsole);
}

function loadSetting(setting, defaultValue) {
    return JSON.parse(window.localStorage.getItem(setting)) || defaultValue;
}

function saveSetting(setting, value) {
    window.localStorage.setItem(setting, JSON.stringify(value));
}

async function getFirmware(filename) {
    const file = findInZip(filename)

    if (!file) {
      const msg = `No firmware file name ${filename} found in the zip!`
      errorMsg(msg)
      throw new Error(msg)
    }

    logMsg(`Unzipping ${filename.replace('VERSION', semver)}...`)
    const firmwareFile = await file.getData(new zip.Uint8ArrayWriter())

    return firmwareFile.buffer // ESPTool wants an ArrayBuffer
}

async function getFileText(path) {
    let response = await fetch(path);
    let contents = await response.text();
    return contents;
}
*/