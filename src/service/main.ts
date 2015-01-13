/// <reference path="hitbtc.ts" />
/// <reference path="okcoin.ts" />
/// <reference path="arbagent.ts" />
/// <reference path="../common/models.ts" />
/// <reference path="../common/messaging.ts" />
/// <reference path="config.ts" />

import Config = require("./config");
import HitBtc = require("./hitbtc");
import OkCoin = require("./okcoin");
import NullGw = require("./nullgw");
import Broker = require("./broker");
import Agent = require("./arbagent");
import Messaging = require("../common/messaging");
import Models = require("../common/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");
import Quoter = require("./quoter");
import Safety = require("./safety");
import path = require("path");
import express = require('express');

var mainLog = Utils.log("tribeca:main");

var app = express();
var http = (<any>require('http')).Server(app);
var io = require('socket.io')(http);

var adminPath = path.join(__dirname, "..", "admin", "admin");
app.get('/', (req, res) => {
    res.sendFile(path.join(adminPath, "index.html"));
});
app.use(express.static(adminPath));
app.use(express.static(path.join(__dirname, "..", "admin", "common")));
app.use(express.static(path.join(__dirname, "..", "admin")));
app.use(express.static(path.join(__dirname, "..", "admin")));
http.listen(3000, () => mainLog('Listening to admins on *:3000...'));

var env = process.env.TRIBECA_MODE;
var config = new Config.ConfigProvider(env);

var getExch = () : Interfaces.CombinedGateway => {
    var ex = process.env.EXCHANGE.toLowerCase();
    switch (ex) {
        case "hitbtc": return <Interfaces.CombinedGateway>(new HitBtc.HitBtc(config));
        case "okcoin": return <Interfaces.CombinedGateway>(new OkCoin.OkCoin(config));
        case "null": return <Interfaces.CombinedGateway>(new NullGw.NullGateway());
        default: throw new Error("unknown configuration env variable EXCHANGE " + ex);
    }
};

var gateway = getExch();

var pair = new Models.CurrencyPair(Models.Currency.BTC, Models.Currency.USD);
var advert = new Models.ProductAdvertisement(gateway.base.exchange(), pair);
new Messaging.Publisher<Models.ProductAdvertisement>(Messaging.Topics.ProductAdvertisement, io, () => [advert]).publish(advert);

var getEnginePublisher = <T>(topic : string) => {
    var wrappedTopic = Messaging.ExchangePairMessaging.wrapExchangePairTopic(gateway.base.exchange(), pair, topic);
    return new Messaging.Publisher<T>(wrappedTopic, io, null, Utils.log("tribeca:messaging"));
};

var quotePublisher = getEnginePublisher<Models.TwoSidedQuote>(Messaging.Topics.Quote);
var fvPublisher = getEnginePublisher(Messaging.Topics.FairValue);
var marketDataPublisher = getEnginePublisher(Messaging.Topics.MarketData);
var orderStatusPublisher = getEnginePublisher(Messaging.Topics.OrderStatusReports);
var safetySettingsPublisher = getEnginePublisher(Messaging.Topics.SafetySettings);
var activePublisher = getEnginePublisher(Messaging.Topics.ActiveChange);
var quotingParametersPublisher = getEnginePublisher(Messaging.Topics.QuotingParametersChange);

var getExchangePublisher = <T>(topic : string) => {
    var wrappedTopic = Messaging.ExchangePairMessaging.wrapExchangeTopic(gateway.base.exchange(), topic);
    return new Messaging.Publisher<T>(wrappedTopic, io, null, Utils.log("tribeca:messaging"));
};

var positionPublisher = getExchangePublisher(Messaging.Topics.Position);
var connectivity = getExchangePublisher(Messaging.Topics.ExchangeConnectivity);

var getReciever = <T>(topic : string) => {
    var wrappedTopic = Messaging.ExchangePairMessaging.wrapExchangePairTopic(gateway.base.exchange(), pair, topic);
    return new Messaging.Receiver<T>(wrappedTopic, io, Utils.log("tribeca:messaging"));
};

var safetySettingsReceiver = getReciever(Messaging.Topics.SafetySettings);
var activeReceiver = getReciever(Messaging.Topics.ActiveChange);
var quotingParametersReceiver = getReciever(Messaging.Topics.QuotingParametersChange);
var submitOrderReceiver = getReciever(Messaging.Topics.SubmitNewOrder);
var cancelOrderReceiver = getReciever(Messaging.Topics.CancelOrder);

var persister = new Broker.OrderStatusPersister();
var broker = new Broker.ExchangeBroker(pair, gateway.md, gateway.base, gateway.oe, gateway.pg,
    persister, marketDataPublisher, orderStatusPublisher, positionPublisher, connectivity,
    submitOrderReceiver, cancelOrderReceiver);

var safetyRepo = new Safety.SafetySettingsRepository(safetySettingsPublisher, safetySettingsReceiver);
var safeties = new Safety.SafetySettingsManager(safetyRepo, broker);

var active = new Agent.ActiveRepository(safeties, activePublisher, activeReceiver);
var paramsRepo = new Agent.QuotingParametersRepository(quotingParametersPublisher, quotingParametersReceiver);

var quoter = new Quoter.Quoter(broker);

var quoteGenerator = new Agent.QuoteGenerator(quoter, broker, paramsRepo, safeties, quotePublisher, fvPublisher, active);

var exitHandler = e => {
    if (!(typeof e === 'undefined') && e.hasOwnProperty('stack'))
        mainLog("Terminating", e, e.stack);
    else
        mainLog("Terminating [no stack]");
    broker.cancelOpenOrders();
    process.exit();
};
process.on("uncaughtException", exitHandler);
process.on("SIGINT", exitHandler);
