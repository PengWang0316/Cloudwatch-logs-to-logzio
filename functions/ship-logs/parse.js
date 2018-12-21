'use strict';

const pricePerGbSecond = 0.00001667;

const calCostForInvocation = function (memorySize, billedDuration) {
  const raw = pricePerGbSecond * (memorySize / 1024) * (billedDuration / 1000);
  return parseFloat(raw.toFixed(9));
};

// logGroup looks like this:
//    "logGroup": "/aws/lambda/service-env-funcName"
const parseFunctionName = function (logGroup) {
  return logGroup.split('/').reverse()[0];
};

// logStream looks like this:
//    "logStream": "2016/08/17/[76]afe5c000d5344c33b5d88be7a4c55816"
const parseLambdaVersion = function (logStream) {
  const start = logStream.indexOf('[');
  const end = logStream.indexOf(']');
  return logStream.substring(start + 1, end);
};

const tryParseJson = function (str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
};

// NOTE: this won't work for some units like Bits/Second, Count/Second, etc.
const toCamelCase = function (str) {
  return str.substr(0, 1).toUpperCase() + str.substr(1);
};

const makeMetric = (value, unit, name, dimensions, namespace, timestamp) => ({
  Value: value,
  Unit: toCamelCase(unit),
  MetricName: name,
  Dimensions: dimensions,
  Namespace: namespace,
  Timestamp: timestamp ? new Date(timestamp) : new Date(),
});

const parseFloatWith = (regex, input) => {
  const res = regex.exec(input);
  return parseFloat(res[1]);
};

// a Lambda function log message looks like this:
//    "2017-04-26T10:41:09.023Z	db95c6da-2a6c-11e7-9550-c91b65931beb\tloading index.html...\n"
// but there are START, END and REPORT messages too:
//    "START RequestId: 67c005bb-641f-11e6-b35d-6b6c651a2f01 Version: 31\n"
//    "END RequestId: 5e665f81-641f-11e6-ab0f-b1affae60d28\n"
//    "REPORT RequestId: 5e665f81-641f-11e6-ab0f-b1affae60d28\tDuration: 1095.52 ms\tBilled Duration: 1100 ms \tMemory Size: 128 MB\tMax Memory Used: 32 MB\t\n"
const parseLogMessage = function (logGroup, logStream, functionName, lambdaVersion, logEvent) {
  if (logEvent.message.startsWith('START RequestId')
      || logEvent.message.startsWith('END RequestId')
      || logEvent.message.startsWith('REPORT RequestId')) {
    return null;
  }

  const parts = logEvent.message.split('\t', 3);
  const timestamp = parts[0];
  const requestId = parts[1];
  const event = parts[2];

  if (event.startsWith('MONITORING|')) {
    return null;
  }

  const log = {
    logGroup,
    logStream,
    functionName,
    lambdaVersion,
    '@timestamp': new Date(timestamp),
    type: 'cloudwatch',
  };

  const fields = tryParseJson(event);
  if (fields) {
    fields.requestId = requestId;

    const level = (fields.level || 'debug').toLowerCase();
    const { message } = fields;

    // level and message are lifted out, so no need to keep them there
    delete fields.level;
    delete fields.message;

    log.level = level;
    log.message = message;
    log.fields = fields;
  } else {
    log.level = 'debug';
    log.message = event;
    log.fields = {};
  }

  return log;
};

const parseCustomMetric = function (functionName, version, logEvent) {
  if (logEvent.message.startsWith('START RequestId')
      || logEvent.message.startsWith('END RequestId')
      || logEvent.message.startsWith('REPORT RequestId')) {
    return null;
  }

  const parts = logEvent.message.split('\t', 3);
  const timestamp = parts[0];
  const requestId = parts[1];
  const event = parts[2];

  if (!event.startsWith('MONITORING|')) {
    return null;
  }

  // MONITORING|metric_value|metric_unit|metric_name|namespace|dimension1=value1, dimension2=value2, ...
  const metricData = event.split('|');
  const metricValue = parseFloat(metricData[1]);
  const metricUnit = toCamelCase(metricData[2].trim());
  const metricName = metricData[3].trim();
  const namespace = metricData[4].trim();

  let dimensions = [
    { Name: 'Function', Value: functionName },
    { Name: 'Version', Value: version },
  ];

  // custom dimensions are optional, so don't assume they're there
  if (metricData.length > 5) {
    const dimensionKVs = metricData[5].trim();
    const customDimensions = dimensionKVs
      .map(kvp => {
        const kv = kvp.trim().split('=');
        return kv.length == 2
          ? { Name: kv[0], Value: kv[1] }
          : null;
      })
      .filter(x => x != null && x != undefined && x.Name != 'Function' && x.Name != 'Version');
    dimensions = dimensions.concat(customDimensions);
  }

  return makeMetric(metricValue, metricUnit, metricName, dimensions, namespace, timestamp);
};

// a typical report message looks like this:
//    "REPORT RequestId: 3897a7c2-8ac6-11e7-8e57-bb793172ae75\tDuration: 2.89 ms\tBilled Duration: 100 ms \tMemory Size: 1024 MB\tMax Memory Used: 20 MB\t\n"
const parseUsageMetrics = function (functionName, version, logEvent) {
  if (logEvent.message.startsWith('REPORT RequestId:')) {
    const parts = logEvent.message.split('\t', 5);

    const billedDuration = parseFloatWith(/Billed Duration: (.*) ms/i, parts[2]);
    const memorySize = parseFloatWith(/Memory Size: (.*) MB/i, parts[3]);
    const memoryUsed = parseFloatWith(/Max Memory Used: (.*) MB/i, parts[4]);
    const cost = calCostForInvocation(memorySize, billedDuration);

    const dimensions = [
      { Name: 'Function', Value: functionName },
      { Name: 'Version', Value: version },
    ];

    const namespace = 'AWS/Lambda';

    return [
      makeMetric(billedDuration, 'milliseconds', 'BilledDuration', dimensions, namespace),
      makeMetric(memorySize, 'megabytes', 'MemorySize', dimensions, namespace),
      makeMetric(memoryUsed, 'megabytes', 'MemoryUsed', dimensions, namespace),
      makeMetric(cost, 'milliseconds', 'CostInDollars', dimensions, namespace),
    ];
  }

  return [];
};

const parseAll = function (logGroup, logStream, logEvents) {
  const lambdaVersion = parseLambdaVersion(logStream);
  const functionName = parseFunctionName(logGroup);

  const logs = logEvents
    .map(e => parseLogMessage(logGroup, logStream, functionName, lambdaVersion, e))
    .filter(log => log != null && log != undefined);

  const customMetrics = logEvents
    .map(e => parseCustomMetric(functionName, lambdaVersion, e))
    .filter(metric => metric != null && metric != undefined);

  const usageMetrics = logEvents
    .map(e => parseUsageMetrics(functionName, lambdaVersion, e))
    .reduce((acc, metrics) => acc.concat(metrics), []);

  return { logs, customMetrics, usageMetrics };
};

module.exports = {
  all: parseAll,
};
