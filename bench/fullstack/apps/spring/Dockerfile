FROM maven:3.10-eclipse-temurin-27@sha256:3175c44b207d6698aecb9bbb5bf285b5b4efcf7f567d6f65d88cd218276a6ab2 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn -q -B dependency:go-offline
COPY src ./src
ADD --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js src/main/resources/static/htmx.min.js
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:27-jre@sha256:05a57c9f4d6d8bf8d8c2213049ea816609672ffcc14463a9c83433a610703e10
WORKDIR /app
COPY --from=build /src/target/app.jar ./
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
