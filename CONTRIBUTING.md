# Contributing to Docker Wake-Up

Thank you for considering contributing to Docker Wake-Up! This document provides guidelines for contributing to the project.

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in the [Issues](https://github.com/jelliott2021/docker-wakeup/issues)
2. If not, create a new issue with:
   - Clear description of the problem
   - Steps to reproduce
   - Expected vs actual behavior
   - System information (OS, Docker version, Node.js version)
   - Relevant configuration files (sanitized)

### Suggesting Features

1. Check existing issues for similar feature requests
2. Create a new issue with:
   - Clear description of the feature
   - Use case and benefits
   - Proposed implementation (if you have ideas)

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes following the coding guidelines below
4. Add tests if applicable
5. Update documentation as needed
6. Commit with clear messages: `git commit -m "Add: brief description"`
7. Push to your fork: `git push origin feature/your-feature-name`
8. Create a Pull Request

## Coding Guidelines

### TypeScript
- Use TypeScript for all new code
- Follow existing code style and patterns
- Add JSDoc comments for public functions
- Use meaningful variable and function names
- Handle errors appropriately

### Testing
- Test new features with multiple Docker services
- Verify NGINX configuration generation
- Test idle shutdown functionality
- Include edge case testing

### Documentation
- Update README.md for new features
- Add inline comments for complex logic
- Update configuration examples
- Include usage examples

## Development Setup

1. Clone your fork:
   ```bash
   git clone https://github.com/jelliott2021/docker-wakeup.git
   cd docker-wakeup
   ```

2. Install dependencies:
   ```bash
   cd wake-proxy && npm install && cd ..
   cd nginx-generator && npm install && cd ..
   ```

3. Create a test configuration:
   ```bash
   cp config.json.example config.json
   # Edit config.json with your test services
   ```

4. Test your changes:
   ```bash
   cd wake-proxy
   npm run build
   npm start
   ```

## Code Style

- Use 2 spaces for indentation
- Use semicolons
- Use single quotes for strings
- Use meaningful commit messages
- Follow existing patterns in the codebase

## Questions?

Feel free to ask questions in:
- GitHub Issues for bug-related questions
- GitHub Discussions for general questions
- Pull Request comments for code-specific questions

Thank you for contributing! 🚀
