'use strict';

const co = require('co');
const Promise = require('bluebird');
const AWS = require('aws-sdk');

// CONFIGURE THESE!!!
// ============================================
const region = 'us-west-2';
const accountId = '598504753594';
const funcName = 'cloudwatch-logs-to-logzio-dev-ship-logs-to-logzio';
const retentionDays = 7; // change this if you want
const prefix = '/aws/lambda'; // use '/' if you want to process every log group
// ============================================

AWS.config.region = region;
const destFuncArn = `arn:aws:lambda:${region}:${accountId}:function:${funcName}`;
const cloudWatchLogs = new AWS.CloudWatchLogs();
const lambda = new AWS.Lambda();

const listLogGroups = co.wrap(function* (acc, nextToken) {
  const req = {
    limit: 50,
    logGroupNamePrefix: prefix,
    nextToken,
  };
  const resp = yield cloudWatchLogs.describeLogGroups(req).promise();

  const newAcc = acc.concat(resp.logGroups.map(x => x.logGroupName));
  if (resp.nextToken) {
    return yield listLogGroups(newAcc, resp.nextToken);
  }
  return newAcc;
});

const subscribe = co.wrap(function* (logGroupName) {
  const options = {
    destinationArn: destFuncArn,
    logGroupName,
    filterName: 'ship-logs',
    filterPattern: '',
  };

  try {
    yield cloudWatchLogs.putSubscriptionFilter(options).promise();
  } catch (err) {
    console.log(`FAILED TO SUBSCRIBE [${logGroupName}]`);
    console.error(JSON.stringify(err));

    if (err.retryable === true) {
      const retryDelay = err.retryDelay || 1000;
      console.log(`retrying in ${retryDelay}ms`);
      yield Promise.delay(retryDelay);
      yield subscribe(logGroupName);
    }
  }
});

const setRetentionPolicy = co.wrap(function* (logGroupName) {
  const params = {
    logGroupName,
    retentionInDays: retentionDays,
  };

  yield cloudWatchLogs.putRetentionPolicy(params).promise();
});

const processAll = co.wrap(function* () {
  const logGroups = yield listLogGroups([]);
  for (const logGroupName of logGroups) {
    console.log(`subscribing [${logGroupName}]...`);
    yield subscribe(logGroupName);

    console.log(`updating retention policy for [${logGroupName}]...`);
    yield setRetentionPolicy(logGroupName);
  }
});

processAll().then(_ => console.log('all done'));
