import ical, { CalendarComponent, FullCalendar } from 'ical';
import http from 'node:http';

type Duration = number;
type Timestamp = number;

const options = {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  host: process.env.HOST ? process.env.HOST : 'localhost',
  icalUrl: process.env.ICAL_URL ? process.env.ICAL_URL : '',
  eventName: process.env.EVENT_NAME ? process.env.EVENT_NAME : 'Slept'
};

const cachedResult: { timestamp: Timestamp, result: string } = {
  timestamp: -Infinity,
  result: ''
};

const processCalendar = (events: FullCalendar, eventName: string, startDate: Date, endDate: Date): {
  totalDuration: Duration,
  lastWakeUp: Timestamp
} => {
  let totalDuration: Duration = 0;
  let lastWakeUp: Timestamp = -Infinity;
  for (const key in events) {
    if (events.hasOwnProperty(key)) {
      const event: CalendarComponent = events[key]!;
      if (event.summary === eventName) {
        if (Number(event.start!) > Number(endDate) || Number(event.end!) < Number(startDate)) {
          continue;
        }
        const validStartDate = Math.max(Number(event.start!), Number(startDate));
        const validEndDate = Math.min(Number(event.end!), Number(endDate));
        if (validStartDate < validEndDate) {
          totalDuration += Number(validEndDate) - Number(validStartDate);
        }
        if (validStartDate > lastWakeUp) {
          lastWakeUp = validEndDate;
        }
      }
    }
  }
  return {
    totalDuration,
    lastWakeUp
  };
};

const requestListener: http.RequestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  if (cachedResult.timestamp + 1000 * 60 * 5 < Number(Date.now())) {
    fetch(options.icalUrl).then((response: Response): Promise<string> => response.text()).then((data: string): void => {
      const events: FullCalendar = ical.parseICS(data);
      let totalDuration: Duration;
      let lastWakeUp: Timestamp;
      let startDate: Date = new Date();
      const endDate: Date = new Date();
      let estimatedTiredness = 0;

      res.writeHead(200, { 'Content-Type': 'text/plain' });

      let result = '';

      startDate = new Date(Number(endDate) - 1000 * 60 * 60 * 24 * 1);
      ({ totalDuration, lastWakeUp } = processCalendar(events, options.eventName, startDate, endDate));
      const lastWakeUpHours = (Date.now() - lastWakeUp) / 1000 / 60 / 60;
      result += `Woke up ${lastWakeUpHours.toFixed(2)}h ago\n`;
      const awakeRatio24H = totalDuration / 1000 / 60 / 60 / 24 / 1;
      result += `Total ${options.eventName} between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDuration / 1000 / 60 / 60).toFixed(2)}h (${(awakeRatio24H * 100).toFixed(2)}%)\n`;
      estimatedTiredness += awakeRatio24H * 1;

      startDate = new Date(Number(endDate) - 1000 * 60 * 60 * 24 * 3);
      ({ totalDuration } = processCalendar(events, options.eventName, startDate, endDate));
      const awakeRatio72H = totalDuration / 1000 / 60 / 60 / 24 / 3;
      result += `Total ${options.eventName} between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDuration / 1000 / 60 / 60).toFixed(2)}h (${(awakeRatio72H * 100).toFixed(2)}%)\n`;
      estimatedTiredness += awakeRatio72H * 1;

      startDate = new Date(Number(endDate) - 1000 * 60 * 60 * 24 * 7);
      ({ totalDuration } = processCalendar(events, options.eventName, startDate, endDate));
      const awakeRatio168H = totalDuration / 1000 / 60 / 60 / 24 / 7;
      result += `Total ${options.eventName} between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDuration / 1000 / 60 / 60).toFixed(2)}h (${(awakeRatio168H * 100).toFixed(2)}%)\n`;
      estimatedTiredness += awakeRatio168H * 1;

      result += `Estimated next sleep: ${((estimatedTiredness / 3) * 48 - lastWakeUpHours).toFixed(2)}h\n`;

      cachedResult.timestamp = Number(Date.now());
      cachedResult.result = result;
      res.end(result);
    }).catch((error) => {
      console.error('Error:', error);
      res.writeHead(500);
      res.end('Internal Server Error');
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(cachedResult.result);
  }
};

http.createServer(requestListener).listen(options.port, options.port, () => {
  console.log(`Server running at http://${options.host}:${options.port}/`);
});
