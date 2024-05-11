import ical, { CalendarComponent, FullCalendar } from 'ical';
import http from 'node:http';

const options = {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  host: process.env.HOST ? process.env.HOST : 'localhost',
  ical: process.env.ICAL ? process.env.ICAL : '',
  eventName: process.env.EVENT_NAME ? process.env.EVENT_NAME : 'Slept'
};

type Duration = number;

const calculateTotalDuration = (events: FullCalendar, eventName: string, startDate: Date, endDate: Date): Duration => {
  let totalDuration: Duration = 0;
  for (const key in events) {
    if (events.hasOwnProperty(key)) {
      const event: CalendarComponent = events[key]!;
      if (event.summary === eventName) {
        const validStartDate = Math.max(Number(event.start!), Number(startDate));
        const validEndDate = Math.min(Number(event.end!), Number(endDate));
        if (validStartDate < validEndDate) {
          totalDuration += Number(validEndDate) - Number(validStartDate);
        }
      }
    }
  }
  return totalDuration;
}

const requestListener: http.RequestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  fetch(options.ical).then((response: Response): Promise<string> => response.text()).then((data: string): void => {
    const events: FullCalendar = ical.parseICS(data);
    let totalDuration: Duration;
    const startDate: Date = new Date();
    const endDate: Date = new Date()
    res.writeHead(200, { 'Content-Type': 'text/plain' });

    let result = '';

    startDate.setDate(endDate.getDate() - 1);
    totalDuration = calculateTotalDuration(events, options.eventName, startDate, endDate);
    result += `Total ${options.eventName} between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDuration / 1000 / 60 / 60).toFixed(2)}h (${(totalDuration / 1000 / 60 / 60 / 24 / 1 * 100).toFixed(2)}%)\n`;

    startDate.setDate(endDate.getDate() - 3);
    totalDuration = calculateTotalDuration(events, options.eventName, startDate, endDate);
    result += `Total ${options.eventName} between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDuration / 1000 / 60 / 60).toFixed(2)}h (${(totalDuration / 1000 / 60 / 60 / 24 / 3 * 100).toFixed(2)}%)\n`;

    startDate.setDate(endDate.getDate() - 7);
    totalDuration = calculateTotalDuration(events, options.eventName, startDate, endDate);
    result += `Total ${options.eventName} between ${startDate.toISOString()} and ${endDate.toISOString()}: ${(totalDuration / 1000 / 60 / 60).toFixed(2)}h (${(totalDuration / 1000 / 60 / 60 / 24 / 7 * 100).toFixed(2)}%)\n`;

    res.end(result);
  }).catch((error) => {
    console.error('Error:', error);
    res.writeHead(500);
    res.end('Internal Server Error');
  });
};

http.createServer(requestListener).listen(options.port, options.port, () => {
  console.log(`Server running at http://${options.host}:${options.port}/`);
});
