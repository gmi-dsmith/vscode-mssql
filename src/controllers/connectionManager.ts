'use strict';
import vscode = require('vscode');
import Constants = require('../models/constants');
import * as Contracts from '../models/contracts';
import Utils = require('../models/utils');
import Interfaces = require('../models/interfaces');
import { ConnectionUI } from '../views/connectionUI';
import StatusView from '../views/statusView';
import SqlToolsServerClient from '../languageservice/serviceclient';
import { LanguageClient } from 'vscode-languageclient';
import { IPrompter } from '../prompts/question';
import Telemetry from '../models/telemetry';

// Information for a document's connection
class ConnectionInfo {
    // Connection GUID returned from the service host
    public connectionId: string;

    // Credentials used to connect
    public credentials: Interfaces.IConnectionCredentials;
}

// ConnectionManager class is the main controller for connection management
export default class ConnectionManager {
    private _context: vscode.ExtensionContext;
    private _statusView: StatusView;
    private _prompter: IPrompter;
    private _connections: { [fileUri: string]: ConnectionInfo };
    private _connectionUI: ConnectionUI;

    constructor(context: vscode.ExtensionContext, statusView: StatusView, prompter: IPrompter) {
        this._context = context;
        this._statusView = statusView;
        this._prompter = prompter;
        this._connectionUI = new ConnectionUI(context, prompter);
        this._connections = {};
    }

    private get connectionUI(): ConnectionUI {
        return this._connectionUI;
    }

    private get statusView(): StatusView {
        return this._statusView;
    }

    public isConnected(fileUri: string): boolean {
        return (fileUri in this._connections);
    }

    // choose database to use on current server
    public onChooseDatabase(): void {
        const self = this;
        const fileUri = Utils.getActiveTextEditorUri();

        if (!self.isConnected(fileUri)) {
            Utils.showWarnMsg(Constants.msgChooseDatabaseNotConnected);
            return;
        }

        self.connectionUI.showDatabasesOnCurrentServer(self._connections[fileUri].credentials).then( newDatabaseCredentials => {
            if (typeof newDatabaseCredentials !== 'undefined') {
                self.disconnect(fileUri).then( () => {
                    self.connect(fileUri, newDatabaseCredentials);
                });
            }
        });
    }

    // close active connection, if any
    public onDisconnect(): Promise<boolean> {
        return this.disconnect(Utils.getActiveTextEditorUri());
    }

    public disconnect(fileUri: string): Promise<boolean> {
        const self = this;

        return new Promise<boolean>((resolve, reject) => {
            if (this.isConnected(fileUri)) {
                let disconnectParams = new Contracts.DisconnectParams();
                disconnectParams.ownerUri = fileUri;

                let client: LanguageClient = SqlToolsServerClient.getInstance().getClient();
                client.sendRequest(Contracts.DisconnectRequest.type, disconnectParams).then((result) => {
                    this.statusView.notConnected(fileUri);
                    delete self._connections[fileUri];

                    resolve(result);
                });
            }
            resolve(true);
        });
    }

    // let users pick from a picklist of connections
    public onNewConnection(): Promise<boolean> {
        const self = this;
        const fileUri = Utils.getActiveTextEditorUri();

        if (fileUri === '') {
            // A text document needs to be open before we can connect
            Utils.showInfoMsg(Constants.msgOpenSqlFile);
        }

        return new Promise<boolean>((resolve, reject) => {
            // show connection picklist
            self.connectionUI.showConnections()
            .then(function(connectionCreds): void {
                if (connectionCreds) {
                    // close active connection
                    self.disconnect(fileUri).then(function(): void {
                        // connect to the server/database
                        self.connect(fileUri, connectionCreds)
                        .then(function(): void {
                            resolve(true);
                        });
                    });
                }
            });
        });
    }

    // create a new connection with the connectionCreds provided
    public connect(fileUri: string, connectionCreds: Interfaces.IConnectionCredentials): Promise<boolean> {
        const self = this;

        return new Promise<boolean>((resolve, reject) => {
            let extensionTimer = new Utils.Timer();

            self.statusView.connecting(fileUri, connectionCreds);

            // package connection details for request message
            let connectionDetails = new Contracts.ConnectionDetails();
            connectionDetails.userName = connectionCreds.user;
            connectionDetails.password = connectionCreds.password;
            connectionDetails.serverName = connectionCreds.server;
            connectionDetails.databaseName = connectionCreds.database;

            let connectParams = new Contracts.ConnectParams();
            connectParams.ownerUri = fileUri;
            connectParams.connection = connectionDetails;

            let serviceTimer = new Utils.Timer();

            // send connection request message to service host
            let client: LanguageClient = SqlToolsServerClient.getInstance().getClient();
            client.sendRequest(Contracts.ConnectionRequest.type, connectParams).then((result) => {
                // handle connection complete callback
                serviceTimer.end();

                if (result.connectionId && result.connectionId !== '') {
                    // We have a valid connection
                    let connection = new ConnectionInfo();
                    connection.connectionId = result.connectionId;
                    connection.credentials = connectionCreds;
                    self._connections[fileUri] = connection;

                    self.statusView.connectSuccess(fileUri, connectionCreds);

                    extensionTimer.end();

                    Telemetry.sendTelemetryEvent(self._context, 'DatabaseConnected', {}, {
                        extensionConnectionTime: extensionTimer.getDuration() - serviceTimer.getDuration(),
                        serviceConnectionTime: serviceTimer.getDuration()
                    });

                    resolve(true);
                } else {
                    Utils.showErrorMsg(Constants.msgError + result.messages);
                    self.statusView.connectError(fileUri, connectionCreds, result.messages);

                    reject();
                }
            });
        });
    }

    public onCreateProfile(): Promise<boolean> {
        let self = this;
        return new Promise<any>((resolve, reject) => {
            self.connectionUI.createAndSaveProfile()
            .then(profile => {
                if (profile) {
                    resolve(true);
                } else {
                    resolve(false);
            }});
        });
    }

    public onRemoveProfile(): Promise<boolean> {
        return this.connectionUI.removeProfile();
    }
}
