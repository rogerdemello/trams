# Internship Assignment (original brief — preserved verbatim)

> This is the assignment as received. The engineering plan derived from it lives in
> [`../plan.md`](../plan.md).

---

Thank you for your interest in our internship opening. As a next step, we are expecting you to complete a short assignment.

Design and implement a small **microservices-based system** consisting of two backend services and one API Gateway.

The assignment will evaluate your understanding of **distributed systems, secure inter-service communication, event-driven architecture, scalability, and clean code practices**.

## Components

1. **User Service**
2. **Notification Service**
3. **API Gateway**

## Communication Requirements

The User Service and Notification Service **must communicate without REST APIs or WebSockets**.

Use a message broker such as:

- **NATS (Preferred)**
- RabbitMQ

Communication must be:

- Secure
- Reliable
- Production-ready
- Asynchronous

## Expectations

- Follow a clean and scalable architecture.
- Implement appropriate authentication and security measures.
- Handle failures and message delivery reliably.
- Use proper error handling and validation.
- Keep sensitive credentials/configuration in environment variables.
- Write clean, maintainable, and well-structured code.

## Submission

- Source code / GitHub repository
- README with setup instructions
- Architecture diagram
- API documentation
- Instructions to run the services locally

Thanks,
Div
