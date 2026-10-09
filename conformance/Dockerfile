FROM node:20-bookworm
RUN npm install -g @getgauge/cli@1.6.38 && gauge install ts && gauge install html-report
WORKDIR /app
COPY . .
CMD ["bash", "conformance/run-in-docker.sh"]
